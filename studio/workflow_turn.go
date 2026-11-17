package studio

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strings"
)

type workflowTurnStartArgs struct {
	operation
	StageID    string `json:"stageId"`
	RunID      string `json:"runId"`
	Activation int64  `json:"activation"`
	SnapshotID string `json:"snapshotId"`
	HandoffID  string `json:"handoffId,omitempty"`
}

type workflowTurnFinishArgs struct {
	operation
	RunID string `json:"runId"`
	Error string `json:"error,omitempty"`
}

type workflowKickoffFailedArgs struct {
	operation
	HandoffID string `json:"handoffId"`
	Error     string `json:"error"`
}

type workflowTurnFailedArgs struct {
	operation
	StageID    string `json:"stageId"`
	Activation int64  `json:"activation"`
	Error      string `json:"error"`
}

type workflowTurnResult struct {
	workflowSessionResult
	ProductionSpec     productionSpec          `json:"productionSpec"`
	Inputs             []workflowHandoff       `json:"inputs"`
	Artifacts          []workflowArtifact      `json:"artifacts"`
	GenerationProgress *workflowGenerationView `json:"generationProgress,omitempty"`
	GenerationResults  []workflowRef           `json:"generationResults,omitempty"`
}

type workflowTurn struct {
	id, stageID, sessionID, status, inputKey string
	workflowFileVersions
	activation int64
	snapshotID string
}

func readWorkflowTurn(ctx context.Context, tx *sql.Tx, runID string) (workflowTurn, error) {
	var turn workflowTurn
	err := tx.QueryRowContext(ctx, `SELECT id,stage_id,session_id,status,input_key,skill_sha,harness_sha,activation,COALESCE(snapshot_id,'')
		FROM workflow_turns WHERE id=?`, runID).Scan(&turn.id, &turn.stageID, &turn.sessionID, &turn.status,
		&turn.inputKey, &turn.SkillSHA256, &turn.HarnessSHA256, &turn.activation, &turn.snapshotID)
	return turn, err
}

func sessionResult(profile *workflowProfile, session workflowSession) workflowSessionResult {
	result := workflowSessionResult{Session: session, WorkflowID: dramaWorkflowID, ProfileSelectionRequired: profile == nil}
	if profile != nil {
		result.WorkflowProfileID, result.WorkflowProfileName = profile.ID, profile.Name
		result.WorkflowDefinitionVersion = profile.Version
	}
	if index := profile.stageIndex(session.ActiveStageID); index >= 0 {
		stage := profile.stage(index)
		result.Stage = &stage
	}
	return result
}

func readWorkflowSessionResult(ctx context.Context, query rowQuery, sessionID string) (workflowSessionResult, error) {
	profile, err := readWorkflowProfile(ctx, query)
	if err != nil {
		return workflowSessionResult{}, err
	}
	session, err := readWorkflowSession(ctx, query, sessionID)
	return sessionResult(profile, session), err
}

func (p *project) startWorkflowTurn(ctx context.Context, r Request, args workflowTurnStartArgs) (any, error) {
	if args.StageID == "" || strings.TrimSpace(args.RunID) == "" || len(args.RunID) > 160 ||
		args.Activation <= 0 || !validWorkflowSHA256(args.SnapshotID) {
		return nil, invalid("原生回合需要有效的阶段 ID、运行 ID 和能力版本")
	}
	var locked bool
	result, err := p.write(ctx, r, args.operation.ID, func(tx *sql.Tx, _ Status) (any, error) {
		profile, err := readWorkflowProfile(ctx, tx)
		if err != nil {
			return nil, err
		}
		stageIndex := profile.stageIndex(args.StageID)
		if stageIndex < 0 {
			return nil, workflowChanged
		}
		session, err := readWorkflowSession(ctx, tx, r.SessionID)
		if err != nil {
			return nil, err
		}
		if session.ActiveStageID != args.StageID || session.Activation != args.Activation {
			return nil, workflowChanged
		}
		if session.LegacyActivation {
			return nil, workflowLegacyActivation
		}
		if session.SnapshotID != args.SnapshotID {
			return nil, workflowChanged
		}
		if session.RunID != "" {
			return nil, &requestError{http.StatusConflict, "当前 Session 已有阶段回合正在执行"}
		}
		latest, err := readLatestWorkflowHandoffs(ctx, tx)
		if err != nil {
			return nil, err
		}
		if err := profile.requireWorkflowInputs(latest, stageIndex); err != nil {
			return nil, err
		}
		inputs := profile.inputs(latest, stageIndex)
		if args.HandoffID != "" {
			if session.PendingHandoffID != args.HandoffID || stageIndex == 0 ||
				!hasWorkflowInput(inputs, args.HandoffID) {
				return nil, &requestError{http.StatusConflict, "交接的初始任务已启动或交接版本已更新"}
			}
		}
		spec, err := readProductionSpec(ctx, tx)
		if err != nil {
			return nil, err
		}
		out := workflowTurnResult{Inputs: inputs, ProductionSpec: spec}
		inputKey := workflowInputKey(inputs, spec)
		out.Artifacts, err = readCurrentWorkflowDrafts(ctx, tx, r.SessionID, args.StageID, inputKey)
		if err != nil {
			return nil, err
		}
		if args.StageID == workflowGeneration {
			progress, results, err := workflowGenerationProgress(ctx, tx, p.dir, latest)
			if err != nil {
				return nil, err
			}
			out.GenerationProgress, out.GenerationResults = &progress, results
		}
		if err := p.lockWorkflowTurn(args.RunID); err != nil {
			return nil, err
		}
		locked = true
		if _, err := tx.ExecContext(ctx, `INSERT INTO workflow_turns(id,session_id,stage_id,activation,status,input_key,skill_sha,harness_sha,started_at,snapshot_id)
			VALUES(?,?,?,?,'running',?,?,?,?,?)`, args.RunID, r.SessionID, args.StageID, session.Activation,
			inputKey, session.SkillSHA256, session.HarnessSHA256, workflowNow(), session.SnapshotID); err != nil {
			return nil, err
		}
		if args.HandoffID != "" {
			session.PendingHandoffID = ""
		}
		if _, err := tx.ExecContext(ctx, `UPDATE workflow_sessions SET pending_handoff=?,error=''
			WHERE session_id=?`, session.PendingHandoffID, r.SessionID); err != nil {
			return nil, err
		}
		if _, err := addEvent(ctx, tx, "workflow", []string{r.SessionID}); err != nil {
			return nil, err
		}
		session.Status, session.RunID, session.Error = workflowRunning, args.RunID, ""
		out.workflowSessionResult = sessionResult(profile, session)
		return out, nil
	})
	if err != nil && locked {
		p.unlockWorkflowTurn(args.RunID)
	}
	return result, err
}

func workflowErrorText(value string) string {
	runes := []rune(strings.TrimSpace(value))
	if len(runes) > 2000 {
		runes = runes[:2000]
	}
	return string(runes)
}

func (p *project) finishWorkflowTurn(ctx context.Context, r Request, args workflowTurnFinishArgs) (any, error) {
	result, err := p.write(ctx, r, args.operation.ID, func(tx *sql.Tx, _ Status) (any, error) {
		turn, err := readWorkflowTurn(ctx, tx, args.RunID)
		if errors.Is(err, sql.ErrNoRows) || err == nil && turn.sessionID != r.SessionID {
			return nil, workflowForbidden
		}
		if err != nil {
			return nil, err
		}
		if turn.status == workflowRunning {
			if !p.ownsWorkflowTurn(turn.id) {
				return nil, workflowChanged
			}
			if err := updateFinishedWorkflowTurn(ctx, tx, turn, workflowErrorText(args.Error)); err != nil {
				return nil, err
			}
		}
		return readWorkflowSessionResult(ctx, tx, r.SessionID)
	})
	if err == nil {
		p.unlockWorkflowTurn(args.RunID)
	}
	return result, err
}

func updateFinishedWorkflowTurn(ctx context.Context, tx *sql.Tx, turn workflowTurn, reason string) error {
	state := "finished"
	if reason != "" {
		state = workflowFailed
	}
	if _, err := tx.ExecContext(ctx, `UPDATE workflow_turns SET status=?,error=?,finished_at=? WHERE id=?`,
		state, reason, workflowNow(), turn.id); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE workflow_sessions SET error=? WHERE session_id=? AND activation=?`,
		reason, turn.sessionID, turn.activation); err != nil {
		return err
	}
	_, err := addEvent(ctx, tx, "workflow", []string{turn.sessionID})
	return err
}

func (p *project) failWorkflowKickoff(ctx context.Context, r Request, args workflowKickoffFailedArgs) (any, error) {
	return p.markWorkflowAdmissionFailed(ctx, r, args.operation, "", args.HandoffID, 0, args.Error)
}

func (p *project) markWorkflowAdmissionFailed(ctx context.Context, r Request, op operation, stageID, handoffID string, activation int64, reason string) (any, error) {
	text := workflowErrorText(reason)
	if text == "" || (handoffID == "" && (stageID == "" || activation <= 0)) {
		return nil, invalid("需要当前阶段或交接 ID 和失败原因")
	}
	return p.write(ctx, r, op.ID, func(tx *sql.Tx, _ Status) (any, error) {
		profile, err := readWorkflowProfile(ctx, tx)
		if err != nil {
			return nil, err
		}
		session, err := readWorkflowSession(ctx, tx, r.SessionID)
		if err != nil {
			return nil, err
		}
		matches := handoffID != "" && handoffID == session.PendingHandoffID ||
			stageID != "" && stageID == session.ActiveStageID && activation == session.Activation && session.PendingHandoffID == ""
		if matches && session.RunID == "" {
			if _, err := tx.ExecContext(ctx, `UPDATE workflow_sessions SET error=? WHERE session_id=?`, text, r.SessionID); err != nil {
				return nil, err
			}
			if _, err := addEvent(ctx, tx, "workflow", []string{r.SessionID}); err != nil {
				return nil, err
			}
			session.Status, session.Error = workflowFailed, text
		}
		return sessionResult(profile, session), nil
	})
}

func (p *project) lockWorkflowTurn(id string) error {
	release, err := p.tryTaskLock("workflow-turn:" + id)
	if err != nil {
		return err
	}
	if release == nil {
		return workflowChanged
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.workflowTurnLocks == nil {
		p.workflowTurnLocks = make(map[string]func())
	}
	p.workflowTurnLocks[id] = release
	return nil
}

func (p *project) ownsWorkflowTurn(id string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.workflowTurnLocks[id] != nil
}

func (p *project) unlockWorkflowTurn(id string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if release := p.workflowTurnLocks[id]; release != nil {
		delete(p.workflowTurnLocks, id)
		release()
	}
}

func (p *project) releaseWorkflowTurns() {
	p.mu.Lock()
	defer p.mu.Unlock()
	for id, release := range p.workflowTurnLocks {
		release()
		delete(p.workflowTurnLocks, id)
	}
}

const workflowKickoffSuperseded = "待启动的交接已被更新的正式交接取代，无法重试。可在当前阶段按最新输入继续。"

const invalidWorkflowKickoff = `pending_handoff<>'' AND (?='' OR session_id=?) AND NOT EXISTS (
	SELECT 1 FROM workflow_handoffs h WHERE h.id=workflow_sessions.pending_handoff
		AND h.revision IS NOT NULL AND h.stale=0
		AND json_extract(h.record,'$.targetStageId')=workflow_sessions.stage_id
		AND h.revision=(SELECT MAX(revision) FROM workflow_handoffs WHERE stage_id=h.stage_id)
)`

func expireWorkflowKickoffs(ctx context.Context, tx *sql.Tx, sessionID string) (bool, error) {
	rows, err := tx.QueryContext(ctx, `UPDATE workflow_sessions SET pending_handoff='',error=? WHERE `+
		invalidWorkflowKickoff+` RETURNING session_id`, workflowKickoffSuperseded, sessionID, sessionID)
	if err != nil {
		return false, err
	}
	defer rows.Close()
	var expired []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return false, err
		}
		expired = append(expired, id)
	}
	if err := rows.Err(); err != nil || len(expired) == 0 {
		return false, err
	}
	_, err = addEvent(ctx, tx, "workflow", expired)
	return err == nil, err
}

func (p *project) recoverWorkflow(ctx context.Context, sessionID string) error {
	const running = `SELECT id FROM workflow_turns WHERE status='running' AND (?='' OR session_id=?)`
	rows, err := p.db.QueryContext(ctx, running, sessionID, sessionID)
	if err != nil {
		return err
	}
	var candidates []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		if !p.ownsWorkflowTurn(id) {
			candidates = append(candidates, id)
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if len(candidates) == 0 {
		var expired bool
		if err := p.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM workflow_sessions WHERE `+
			invalidWorkflowKickoff+`)`, sessionID, sessionID).Scan(&expired); err != nil || !expired {
			return err
		}
	}

	tx, err := p.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var recovered bool
	for _, id := range candidates {
		turn, err := readWorkflowTurn(ctx, tx, id)
		if err != nil {
			return err
		}
		if turn.status != workflowRunning {
			continue
		}
		release, err := p.tryTaskLock("workflow-turn:" + id)
		if err != nil {
			return err
		}
		if release == nil {
			continue
		}
		defer release()
		if err := updateFinishedWorkflowTurn(ctx, tx, turn, "DSH Host 已中断。已保存的草稿仍可查看，可继续当前阶段对话。"); err != nil {
			return err
		}
		recovered = true
	}
	expired, err := expireWorkflowKickoffs(ctx, tx, sessionID)
	if err != nil {
		return err
	}
	if recovered || expired {
		if err := tx.Commit(); err != nil {
			return err
		}
		p.notify()
	}
	return nil
}
