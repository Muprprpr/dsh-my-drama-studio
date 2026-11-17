package studio

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"net/http"
	"strings"
	"time"
)

const (
	workflowNotStarted  = "not_started"
	workflowDraft       = "draft_available"
	workflowHandedOff   = "handed_off"
	workflowStale       = "stale"
	workflowRunning     = "running"
	workflowFailed      = "failed"
	dramaWorkflowID     = "drama-production"
	workflowDeployment  = "video-deployment"
	workflowGeneration  = "video-generation"
	workflowFinalReview = "final-review"
	maxWorkflowOutputs  = 100
)

type workflowStage struct {
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	Skill    string   `json:"skill"`
	Harness  string   `json:"harness"`
	Requires []string `json:"requires,omitempty"`
}

type workflowRef struct {
	ID       string `json:"id"`
	Revision int64  `json:"revision"`
}

// Old records and video-generation checks both use exact node revisions.
type workflowApproval struct {
	ID        string        `json:"id"`
	SessionID string        `json:"sessionId"`
	At        string        `json:"at"`
	Outputs   []workflowRef `json:"outputs"`
}

type workflowFileVersions struct {
	SkillSHA256   string `json:"skillSha256,omitempty"`
	HarnessSHA256 string `json:"harnessSha256,omitempty"`
}

func (v workflowFileVersions) valid() bool {
	return validWorkflowSHA256(v.SkillSHA256) && validWorkflowSHA256(v.HarnessSHA256)
}

func validWorkflowSHA256(hash string) bool {
	if len(hash) != 2*sha256.Size || hash != strings.ToLower(hash) {
		return false
	}
	_, err := hex.DecodeString(hash)
	return err == nil
}

type workflowSession struct {
	workflowFileVersions
	ActiveStageID     string `json:"activeStageId,omitempty"`
	Status            string `json:"status"`
	RunID             string `json:"runId,omitempty"`
	Error             string `json:"error,omitempty"`
	PendingHandoffID  string `json:"pendingHandoffId,omitempty"`
	Activation        int64  `json:"activation"`
	TransitionPending bool   `json:"transitionPending"`
	SnapshotID        string `json:"snapshotId,omitempty"`
	ActivatedAt       string `json:"activatedAt,omitempty"`
	LegacyActivation  bool   `json:"legacyActivation,omitempty"`
}

type workflowSessionResult struct {
	Session                   workflowSession   `json:"session"`
	WorkflowID                string            `json:"workflowId"`
	WorkflowProfileID         string            `json:"workflowProfileId,omitempty"`
	WorkflowProfileName       string            `json:"workflowProfileName,omitempty"`
	WorkflowDefinitionVersion int64             `json:"workflowDefinitionVersion,omitempty"`
	ProfileSelectionRequired  bool              `json:"profileSelectionRequired"`
	Stage                     *workflowStage    `json:"stage,omitempty"`
	Snapshot                  *workflowSnapshot `json:"snapshot,omitempty"`
}

type workflowStageView struct {
	workflowStage
	Status     string                  `json:"status"`
	HandoffID  string                  `json:"handoffId,omitempty"`
	Generation *workflowGenerationView `json:"generation,omitempty"`
}

type workflowView struct {
	workflowSessionResult
	ActiveSkillID string              `json:"activeSkillId,omitempty"`
	ID            string              `json:"id"`
	Name          string              `json:"name"`
	Revision      int64               `json:"revision"`
	Stages        []workflowStageView `json:"stages"`
	Artifacts     []workflowArtifact  `json:"artifacts"`
	Handoffs      []workflowHandoff   `json:"handoffs"`
	Inputs        []workflowHandoff   `json:"inputs"`
}

type workflowActivateArgs struct {
	operation
	StageID            string            `json:"stageId"`
	ExpectedActivation *int64            `json:"expectedActivation"`
	Snapshot           *workflowSnapshot `json:"snapshot,omitempty"`
}

var workflowChanged = &requestError{http.StatusConflict, "工作流版本已更新，请刷新后重新检查交接内容"}
var workflowTurnRunning = &requestError{http.StatusConflict, "当前阶段正在执行，请等待本轮完成后再切换。"}

func workflowNow() string { return time.Now().UTC().Format(time.RFC3339Nano) }

func (s *Service) executeWorkflow(ctx context.Context, r Request) (any, error) {
	switch r.Action {
	case "workflow_get", "workflow_profile_select", "workflow_activate", "workflow_handoff_preview", "workflow_handoff_confirm":
		if r.Actor != "human" {
			return nil, workflowForbidden
		}
	case "workflow_artifact_get":
		if r.Actor != "human" && r.Actor != "workflow" {
			return nil, workflowForbidden
		}
	case "workflow_session", "workflow_turn_start", "workflow_turn_finish", "workflow_save_artifact",
		"workflow_kickoff_failed", "workflow_turn_failed", "workflow_transition_complete", "workflow_handoff_target":
		if r.Actor != "workflow" {
			return nil, workflowForbidden
		}
	default:
		return nil, invalid("未知 Workflow 操作：%s", r.Action)
	}

	var activation workflowActivateArgs
	if r.Action == "workflow_activate" {
		if err := decodeData(r.Data, &activation); err != nil {
			return nil, err
		}
		if err := activation.operation.validate(); err != nil {
			return nil, err
		}
		if activation.ExpectedActivation == nil || *activation.ExpectedActivation < 0 {
			return nil, invalid("阶段激活需要当前激活序号")
		}
	}
	var profileArgs workflowProfileArgs
	if r.Action == "workflow_profile_select" {
		if err := decodeData(r.Data, &profileArgs); err != nil {
			return nil, err
		}
		if err := profileArgs.operation.validate(); err != nil {
			return nil, err
		}
		if workflowProfiles[profileArgs.WorkflowProfileID] == nil || profileArgs.WorkflowProfileID == legacyWorkflowProfileID {
			return nil, invalid("请选择支持的新建生产模式")
		}
	}
	var sessionQuery struct {
		StateOnly bool `json:"stateOnly,omitempty"`
	}
	if r.Action == "workflow_session" {
		if err := decodeData(r.Data, &sessionQuery); err != nil {
			return nil, err
		}
	}
	if r.Action == "workflow_get" {
		if err := decodeData(r.Data, &struct{}{}); err != nil {
			return nil, err
		}
	}

	p, err := s.open(ctx, r.WorkspacePath, r.Action == "workflow_profile_select")
	if err != nil {
		return nil, err
	}
	if p == nil {
		switch r.Action {
		case "workflow_session":
			return sessionResult(nil, workflowSession{Status: "normal"}), nil
		case "workflow_get":
			return emptyWorkflowView(nil), nil
		case "workflow_handoff_confirm", "workflow_handoff_target":
			return nil, workflowHandoffPermission
		case "workflow_activate":
			if activation.StageID != "" {
				return nil, workflowProfileRequired
			}
			if *activation.ExpectedActivation == 0 && activation.Snapshot == nil {
				return emptyWorkflowView(nil), nil
			}
			return nil, workflowChanged
		default:
			return nil, workflowChanged
		}
	}
	switch r.Action {
	case "workflow_get", "workflow_session", "workflow_activate", "workflow_turn_start", "workflow_handoff_preview",
		"workflow_handoff_confirm", "workflow_handoff_target":
		if err := p.recoverWorkflow(ctx, r.SessionID); err != nil {
			return nil, err
		}
	}
	switch r.Action {
	case "workflow_get":
		return p.workflowView(ctx, r.SessionID)
	case "workflow_profile_select":
		return p.selectWorkflowProfile(ctx, r, profileArgs)
	case "workflow_session":
		return p.workflowSession(ctx, r.SessionID, sessionQuery.StateOnly)
	case "workflow_activate":
		return p.activateWorkflow(ctx, r, activation)
	case "workflow_transition_complete":
		var args workflowTransitionArgs
		if err := decodeData(r.Data, &args); err != nil {
			return nil, err
		}
		return p.completeWorkflowTransition(ctx, r, args)
	case "workflow_turn_start":
		var args workflowTurnStartArgs
		if err := decodeData(r.Data, &args); err != nil {
			return nil, err
		}
		return p.startWorkflowTurn(ctx, r, args)
	case "workflow_turn_finish":
		var args workflowTurnFinishArgs
		if err := decodeData(r.Data, &args); err != nil {
			return nil, err
		}
		return p.finishWorkflowTurn(ctx, r, args)
	case "workflow_kickoff_failed":
		var args workflowKickoffFailedArgs
		if err := decodeData(r.Data, &args); err != nil {
			return nil, err
		}
		return p.failWorkflowKickoff(ctx, r, args)
	case "workflow_turn_failed":
		var args workflowTurnFailedArgs
		if err := decodeData(r.Data, &args); err != nil {
			return nil, err
		}
		return p.markWorkflowAdmissionFailed(ctx, r, args.operation, args.StageID, "", args.Activation, args.Error)
	case "workflow_save_artifact":
		var args workflowSaveArtifactArgs
		if err := decodeData(r.Data, &args); err != nil {
			return nil, err
		}
		return p.saveWorkflowArtifact(ctx, r, args)
	case "workflow_artifact_get":
		if r.Actor == "workflow" {
			var args workflowArtifactReadArgs
			if err := decodeData(r.Data, &args); err != nil {
				return nil, err
			}
			return p.getWorkflowRunArtifact(ctx, r.SessionID, args)
		}
		var ref workflowArtifactRef
		if err := decodeData(r.Data, &ref); err != nil {
			return nil, err
		}
		return p.getWorkflowArtifact(ctx, r.SessionID, ref)
	case "workflow_handoff_preview":
		var args workflowPreviewArgs
		if err := decodeData(r.Data, &args); err != nil {
			return nil, err
		}
		return p.previewWorkflowHandoff(ctx, r, args)
	case "workflow_handoff_target":
		var args struct {
			HandoffID string `json:"handoffId"`
		}
		if err := decodeData(r.Data, &args); err != nil {
			return nil, err
		}
		return p.workflowHandoffTarget(ctx, r, args.HandoffID)
	default:
		var args workflowConfirmArgs
		if err := decodeData(r.Data, &args); err != nil {
			return nil, err
		}
		return p.confirmWorkflowHandoff(ctx, r, args)
	}
}

var workflowForbidden = &requestError{http.StatusForbidden, "工作流操作身份无效"}

func readWorkflowSession(ctx context.Context, query rowQuery, id string) (workflowSession, error) {
	session := workflowSession{Status: "normal"}
	err := query.QueryRowContext(ctx, `SELECT stage_id, activation, skill_sha, harness_sha, pending_handoff, error,
		COALESCE(snapshot_id,''), activated_at, transition_pending,
		COALESCE((SELECT id FROM workflow_turns WHERE session_id=? AND status='running'),'')
		FROM workflow_sessions WHERE session_id=?`, id, id).
		Scan(&session.ActiveStageID, &session.Activation, &session.SkillSHA256, &session.HarnessSHA256,
			&session.PendingHandoffID, &session.Error, &session.SnapshotID, &session.ActivatedAt, &session.TransitionPending, &session.RunID)
	if errors.Is(err, sql.ErrNoRows) {
		return session, nil
	}
	if err != nil {
		return session, err
	}
	session.LegacyActivation = session.ActiveStageID != "" && session.SnapshotID == ""
	switch {
	case session.ActiveStageID == "":
	case session.RunID != "":
		session.Status = workflowRunning
	case session.LegacyActivation:
		session.Status, session.Error = workflowFailed, workflowLegacyActivation.text
	case session.Error != "":
		session.Status = workflowFailed
	default:
		session.Status = "active"
	}
	return session, nil
}

func (p *project) activateWorkflow(ctx context.Context, r Request, args workflowActivateArgs) (any, error) {
	return p.write(ctx, r, args.operation.ID, func(tx *sql.Tx, _ Status) (any, error) {
		profile, err := readWorkflowProfile(ctx, tx)
		if err != nil {
			return nil, err
		}
		var stageIndex int
		if args.StageID != "" {
			if profile == nil {
				return nil, workflowProfileRequired
			}
			stageIndex = profile.stageIndex(args.StageID)
			if stageIndex < 0 {
				return nil, invalid("当前生产模式没有工作流阶段 %s", args.StageID)
			}
		}
		session, err := readWorkflowSession(ctx, tx, r.SessionID)
		if err != nil {
			return nil, err
		}
		if session.ActiveStageID == args.StageID {
			if session.Activation != *args.ExpectedActivation {
				return nil, workflowChanged
			}
			if session.LegacyActivation {
				return nil, workflowLegacyActivation
			}
		} else {
			if session.RunID != "" {
				return nil, workflowTurnRunning
			}
			if session.Activation != *args.ExpectedActivation {
				return nil, workflowChanged
			}
			if args.StageID != "" && len(profile.Stages[stageIndex].Requires) != 0 {
				latest, err := readLatestWorkflowHandoffs(ctx, tx)
				if err != nil {
					return nil, err
				}
				if err := profile.requireWorkflowInputs(latest, stageIndex); err != nil {
					return nil, err
				}
			}
			if err := advanceWorkflowActivation(ctx, tx, profile, r.SessionID, args.StageID, "", args.Snapshot); err != nil {
				return nil, err
			}
			if _, err := addEvent(ctx, tx, "workflow", []string{r.SessionID}); err != nil {
				return nil, err
			}
		}
		return readWorkflowView(ctx, tx, p.dir, r.SessionID, profile)
	})
}

func emptyWorkflowView(profile *workflowProfile) workflowView {
	view := workflowView{
		ID:                    dramaWorkflowID,
		workflowSessionResult: sessionResult(profile, workflowSession{Status: "normal"}),
		Artifacts:             []workflowArtifact{}, Handoffs: []workflowHandoff{}, Inputs: []workflowHandoff{},
		Stages: []workflowStageView{},
	}
	if profile == nil {
		return view
	}
	view.Name, view.Revision = profile.Name, profile.Version
	view.Stages = make([]workflowStageView, 0, len(profile.Stages))
	for index, stage := range profile.Stages {
		item := workflowStageView{workflowStage: profile.stage(index), Status: workflowNotStarted}
		if stage.ID == workflowGeneration {
			item.Generation = &workflowGenerationView{State: "waiting", Message: "先确认视频节点部署"}
		}
		view.Stages = append(view.Stages, item)
	}
	return view
}

func (p *project) workflowView(ctx context.Context, sessionID string) (workflowView, error) {
	tx, err := p.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return workflowView{}, err
	}
	defer tx.Rollback()
	profile, err := readWorkflowProfile(ctx, tx)
	if err != nil {
		return workflowView{}, err
	}
	return readWorkflowView(ctx, tx, p.dir, sessionID, profile)
}

func readWorkflowView(ctx context.Context, tx *sql.Tx, workspace, sessionID string, profile *workflowProfile) (workflowView, error) {
	view := emptyWorkflowView(profile)
	session, err := readWorkflowSession(ctx, tx, sessionID)
	if err != nil {
		return view, err
	}
	if session.SnapshotID != "" {
		snapshot, err := readWorkflowSnapshot(ctx, tx, profile, session)
		var conflict *requestError
		switch {
		case err == nil:
			view.ActiveSkillID = snapshot.SkillID
		case errors.As(err, &conflict) && conflict.code == http.StatusConflict:
			session.Status, session.Error = workflowFailed, conflict.text
		default:
			return view, err
		}
	}
	view.workflowSessionResult = sessionResult(profile, session)
	history, err := readWorkflowHandoffs(ctx, tx)
	if err != nil {
		return view, err
	}
	latest := latestWorkflowHandoffs(history)
	view.Handoffs = history
	if index := profile.stageIndex(session.ActiveStageID); index >= 0 {
		view.Inputs = profile.inputs(latest, index)
	}
	drafts, err := readOwnWorkflowArtifacts(ctx, tx, sessionID)
	if err != nil {
		return view, err
	}
	artifacts := make(map[workflowArtifactRef]int, len(drafts))
	inputKeys := make(map[string]string, len(view.Stages))
	for index, stage := range view.Stages {
		inputKeys[stage.ID] = workflowInputKey(profile.inputs(latest, index))
	}
	for _, artifact := range drafts {
		artifact.InputOutdated = artifact.inputKey != inputKeys[artifact.StageID]
		artifacts[artifact.workflowArtifactRef] = len(view.Artifacts)
		view.Artifacts = append(view.Artifacts, artifact)
	}
	for _, handoff := range history {
		for _, artifact := range handoff.Artifacts {
			artifact.HandedOff = true
			if index, exists := artifacts[artifact.workflowArtifactRef]; exists {
				view.Artifacts[index].HandedOff = true
			} else {
				artifacts[artifact.workflowArtifactRef] = len(view.Artifacts)
				view.Artifacts = append(view.Artifacts, artifact)
			}
		}
	}
	for i := range view.Stages {
		item := &view.Stages[i]
		handoff, handedOff := latest[item.ID]
		if handedOff {
			item.HandoffID, item.Status = handoff.HandoffID, workflowHandedOff
			if handoff.Stale {
				item.Status = workflowStale
			}
		} else {
			var draft bool
			if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM workflow_artifacts WHERE stage_id=?)`, item.ID).Scan(&draft); err != nil {
				return view, err
			}
			if draft {
				item.Status = workflowDraft
			}
		}
		if item.ID == workflowGeneration {
			progress, _, err := workflowGenerationProgress(ctx, tx, workspace, latest)
			if err != nil {
				return view, err
			}
			item.Generation = &progress
		}
	}
	return view, nil
}

func workflowGenerationProgress(ctx context.Context, tx *sql.Tx, workspace string, latest map[string]workflowHandoff) (workflowGenerationView, []workflowRef, error) {
	handoff, ok := latest[workflowDeployment]
	if !ok || handoff.Stale {
		return workflowGenerationView{State: "waiting", Message: "先确认视频节点部署"}, nil, nil
	}
	refs := workflowMediaRefs(handoff.Artifacts)
	if err := checkWorkflowRefs(ctx, tx, refs); err != nil {
		var known *requestError
		if errors.As(err, &known) {
			return workflowGenerationView{State: "waiting", Message: known.text}, nil, nil
		}
		return workflowGenerationView{}, nil, err
	}
	return generationProgress(ctx, tx, workspace, refs)
}

func checkWorkflowRefs(ctx context.Context, tx *sql.Tx, refs []workflowRef) error {
	for _, ref := range refs {
		var live bool
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM nodes WHERE id=? AND revision=? AND deleted=0)`,
			ref.ID, ref.Revision).Scan(&live); err != nil {
			return err
		}
		if !live {
			return &requestError{http.StatusConflict, "产物已修改或删除，请在 Canvas 检查并重新记录当前版本"}
		}
	}
	return nil
}
