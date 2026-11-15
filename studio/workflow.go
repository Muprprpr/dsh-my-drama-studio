package studio

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"net/http"
	"slices"
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
	dramaWorkflowName   = "AI 短剧制作"
	dramaWorkflowRev    = 1
	workflowDeployment  = "video-deployment"
	workflowGeneration  = "video-generation"
	workflowFinalReview = "final-review"
	maxWorkflowOutputs  = 100
)

type workflowStage struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Skill   string `json:"skill"`
	Harness string `json:"harness"`
}

func dramaStage(id, name string) workflowStage {
	return workflowStage{ID: id, Name: name, Skill: "drama-" + id, Harness: "stages/" + id + "/harness.md"}
}

var dramaWorkflowStages = []workflowStage{
	dramaStage("content-analysis", "内容分析"),
	dramaStage("shooting-script", "拍摄脚本制作"),
	dramaStage("storyboard", "分镜制作"),
	dramaStage("asset-binding", "素材抽卡与绑定"),
	dramaStage(workflowDeployment, "视频节点部署"),
	dramaStage(workflowGeneration, "视频生成"),
	dramaStage(workflowFinalReview, "成片验收"),
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
	ActiveStageID    string `json:"activeStageId,omitempty"`
	Status           string `json:"status"`
	RunID            string `json:"runId,omitempty"`
	Error            string `json:"error,omitempty"`
	PendingHandoffID string `json:"pendingHandoffId,omitempty"`
	activation       int64
}

type workflowSessionResult struct {
	Session    workflowSession `json:"session"`
	WorkflowID string          `json:"workflowId"`
	Stage      *workflowStage  `json:"stage,omitempty"`
}

type workflowStageView struct {
	workflowStage
	Status     string                  `json:"status"`
	HandoffID  string                  `json:"handoffId,omitempty"`
	Generation *workflowGenerationView `json:"generation,omitempty"`
}

type workflowView struct {
	workflowSessionResult
	ID        string              `json:"id"`
	Name      string              `json:"name"`
	Revision  int64               `json:"revision"`
	Stages    []workflowStageView `json:"stages"`
	Artifacts []workflowArtifact  `json:"artifacts"`
	Handoffs  []workflowHandoff   `json:"handoffs"`
	Inputs    []workflowHandoff   `json:"inputs"`
}

type workflowActivateArgs struct {
	operation
	workflowFileVersions
	StageID string `json:"stageId"`
}

var workflowChanged = &requestError{http.StatusConflict, "工作流版本已更新，请刷新后重新检查交接内容"}

func workflowNow() string { return time.Now().UTC().Format(time.RFC3339Nano) }

func workflowStageIndex(stageID string) int {
	return slices.IndexFunc(dramaWorkflowStages, func(stage workflowStage) bool { return stage.ID == stageID })
}

func (s *Service) executeWorkflow(ctx context.Context, r Request) (any, error) {
	switch r.Action {
	case "workflow_get", "workflow_activate", "workflow_handoff_preview", "workflow_handoff_confirm":
		if r.Actor != "human" {
			return nil, workflowForbidden
		}
	case "workflow_session", "workflow_artifact_get":
		if r.Actor != "human" && r.Actor != "workflow" {
			return nil, workflowForbidden
		}
	case "workflow_turn_start", "workflow_turn_finish", "workflow_save_artifact", "workflow_kickoff_failed", "workflow_turn_failed":
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
		if activation.StageID != "" && workflowStageIndex(activation.StageID) < 0 {
			return nil, invalid("未知工作流阶段")
		}
		if activation.StageID != "" && !activation.workflowFileVersions.valid() {
			return nil, invalid("阶段激活需要有效的 Skill 和 Harness SHA-256")
		}
	}
	if r.Action == "workflow_session" || r.Action == "workflow_get" {
		if err := decodeData(r.Data, &struct{}{}); err != nil {
			return nil, err
		}
	}

	p, err := s.open(ctx, r.WorkspacePath, r.Action == "workflow_activate" && activation.StageID != "")
	if err != nil {
		return nil, err
	}
	if p == nil {
		switch r.Action {
		case "workflow_session":
			return sessionResult(workflowSession{Status: "normal"}), nil
		case "workflow_get", "workflow_activate":
			return emptyWorkflowView(), nil
		default:
			return nil, workflowChanged
		}
	}
	switch r.Action {
	case "workflow_get", "workflow_session", "workflow_activate", "workflow_turn_start", "workflow_handoff_preview", "workflow_handoff_confirm":
		if err := p.recoverWorkflow(ctx, r.SessionID); err != nil {
			return nil, err
		}
	}
	switch r.Action {
	case "workflow_get":
		return p.workflowView(ctx, r.SessionID)
	case "workflow_session":
		session, err := readWorkflowSession(ctx, p.db, r.SessionID)
		return sessionResult(session), err
	case "workflow_activate":
		return p.activateWorkflow(ctx, r, activation)
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
		return p.markWorkflowAdmissionFailed(ctx, r, args.operation, args.StageID, "", args.Error)
	case "workflow_save_artifact":
		var args workflowSaveArtifactArgs
		if err := decodeData(r.Data, &args); err != nil {
			return nil, err
		}
		return p.saveWorkflowArtifact(ctx, r, args)
	case "workflow_artifact_get":
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
		COALESCE((SELECT id FROM workflow_turns WHERE session_id=? AND status='running'),'')
		FROM workflow_sessions WHERE session_id=?`, id, id).
		Scan(&session.ActiveStageID, &session.activation, &session.SkillSHA256, &session.HarnessSHA256, &session.PendingHandoffID, &session.Error, &session.RunID)
	if errors.Is(err, sql.ErrNoRows) {
		return session, nil
	}
	if err != nil {
		return session, err
	}
	switch {
	case session.ActiveStageID == "":
		session.RunID = ""
	case session.RunID != "":
		session.Status = workflowRunning
	case session.Error != "":
		session.Status = workflowFailed
	default:
		session.Status = "active"
	}
	return session, nil
}

func (p *project) activateWorkflow(ctx context.Context, r Request, args workflowActivateArgs) (any, error) {
	return p.write(ctx, r, args.operation.ID, func(tx *sql.Tx, _ Status) (any, error) {
		session, err := readWorkflowSession(ctx, tx, r.SessionID)
		if err != nil {
			return nil, err
		}
		if session.ActiveStageID != args.StageID {
			_, err := tx.ExecContext(ctx, `INSERT INTO workflow_sessions(session_id,stage_id,activation,skill_sha,harness_sha)
				VALUES(?,?,1,?,?) ON CONFLICT(session_id) DO UPDATE SET stage_id=excluded.stage_id,
				activation=activation+1, skill_sha=excluded.skill_sha, harness_sha=excluded.harness_sha,
				pending_handoff='', error=''`, r.SessionID, args.StageID, args.SkillSHA256, args.HarnessSHA256)
			if err != nil {
				return nil, err
			}
			if _, err := addEvent(ctx, tx, "workflow", []string{r.SessionID}); err != nil {
				return nil, err
			}
		}
		return readWorkflowView(ctx, tx, p.dir, r.SessionID)
	})
}

func emptyWorkflowView() workflowView {
	view := workflowView{
		ID: dramaWorkflowID, Name: dramaWorkflowName, Revision: dramaWorkflowRev,
		workflowSessionResult: sessionResult(workflowSession{Status: "normal"}),
		Artifacts:             []workflowArtifact{}, Handoffs: []workflowHandoff{}, Inputs: []workflowHandoff{},
		Stages: make([]workflowStageView, 0, len(dramaWorkflowStages)),
	}
	for _, stage := range dramaWorkflowStages {
		item := workflowStageView{workflowStage: stage, Status: workflowNotStarted}
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
	return readWorkflowView(ctx, tx, p.dir, sessionID)
}

func readWorkflowView(ctx context.Context, tx *sql.Tx, workspace, sessionID string) (workflowView, error) {
	view := emptyWorkflowView()
	session, err := readWorkflowSession(ctx, tx, sessionID)
	if err != nil {
		return view, err
	}
	view.workflowSessionResult = sessionResult(session)
	history, err := readWorkflowHandoffs(ctx, tx)
	if err != nil {
		return view, err
	}
	latest := latestWorkflowHandoffs(history)
	view.Handoffs = history
	if index := workflowStageIndex(session.ActiveStageID); index >= 0 {
		view.Inputs = workflowInputs(latest, index)
	}
	drafts, err := readOwnWorkflowArtifacts(ctx, tx, sessionID, "", false)
	if err != nil {
		return view, err
	}
	artifacts := make(map[workflowArtifactRef]int, len(drafts))
	for _, artifact := range drafts {
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
