package studio

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
)

const (
	workflowNotStarted   = "not_started"
	workflowStarting     = "starting"
	workflowRunning      = "running"
	workflowReview       = "review"
	workflowApproved     = "approved"
	workflowFailed       = "failed"
	workflowStale        = "stale"
	maxWorkflowOutputs   = 100
	workflowStartTimeout = 2 * time.Minute
	dramaWorkflowID      = "drama-production"
	dramaWorkflowName    = "AI 短剧制作"
	dramaWorkflowRev     = 1
	workflowDeployment   = "video-deployment"
	workflowGeneration   = "video-generation"
)

type workflowStage struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Skill   string `json:"skill"`
	Harness string `json:"harness,omitempty"`
}

func dramaStage(id, name string) workflowStage {
	return workflowStage{ID: id, Name: name, Skill: "drama-" + id, Harness: "stages/" + id + "/harness.md"}
}

// This order is the production dependency chain. Every stage requires review.
var dramaWorkflowStages = []workflowStage{
	dramaStage("content-analysis", "内容分析"),
	dramaStage("shooting-script", "拍摄脚本制作"),
	dramaStage("storyboard", "分镜制作"),
	dramaStage("asset-binding", "素材抽卡与绑定"),
	dramaStage(workflowDeployment, "视频节点部署"),
	dramaStage(workflowGeneration, "视频生成"),
	dramaStage("final-review", "成片验收"),
}

type workflowRef struct {
	ID       string `json:"id"`
	Revision int64  `json:"revision"`
}

type workflowApproval struct {
	ID        string        `json:"id"`
	SessionID string        `json:"sessionId"`
	At        string        `json:"at"`
	Outputs   []workflowRef `json:"outputs"`
}

type workflowRunScope struct {
	WorkspaceID       string `json:"workspaceId,omitempty"`
	CanvasID          string `json:"canvasId,omitempty"`
	DefinitionVersion int64  `json:"definitionVersion,omitempty"`
}

type workflowFileVersions struct {
	SkillSHA256   string `json:"skillSha256,omitempty"`
	HarnessSHA256 string `json:"harnessSha256,omitempty"`
}

type workflowRun struct {
	workflowRunScope
	workflowFileVersions
	ID, SessionID, Status string             `json:"-"`
	WorkflowID            string             `json:"workflowId,omitempty"`
	Stage                 workflowStage      `json:"stage"`
	PreviousApproval      string             `json:"previousApproval,omitempty"`
	Inputs                []workflowRef      `json:"inputs"`
	GenerationResults     []workflowRef      `json:"generationResults,omitempty"`
	GenerationTasks       []string           `json:"generationTasks,omitempty"`
	NodeWatermark         int64              `json:"nodeWatermark"`
	Outputs               []workflowRef      `json:"outputs,omitempty"`
	Approvals             []workflowApproval `json:"approvals,omitempty"`
	Error                 string             `json:"error,omitempty"`
	ReservedAt            string             `json:"reservedAt"`
	StartedAt             string             `json:"startedAt,omitempty"`
	FinishedAt            string             `json:"finishedAt,omitempty"`
}

type workflowStageView struct {
	workflowStage
	workflowRunScope
	workflowFileVersions
	Status      string                  `json:"status"`
	Pending     bool                    `json:"pending,omitempty"`
	RunID       string                  `json:"runId,omitempty"`
	SessionID   string                  `json:"sessionId,omitempty"`
	SkillID     string                  `json:"skillId,omitempty"`
	ReservedAt  string                  `json:"reservedAt,omitempty"`
	StartedAt   string                  `json:"startedAt,omitempty"`
	FinishedAt  string                  `json:"finishedAt,omitempty"`
	Inputs      []workflowRef           `json:"inputs,omitempty"`
	Outputs     []workflowRef           `json:"outputs,omitempty"`
	ApprovalID  string                  `json:"approvalId,omitempty"`
	Approvals   []workflowApproval      `json:"approvals,omitempty"`
	NeedsReview bool                    `json:"needsReview,omitempty"`
	NeedsRerun  bool                    `json:"needsRerun,omitempty"`
	Generation  *workflowGenerationView `json:"generation,omitempty"`
	Error       string                  `json:"error,omitempty"`
}

type workflowView struct {
	ID       string              `json:"id"`
	Name     string              `json:"name"`
	Revision int64               `json:"revision"`
	Stages   []workflowStageView `json:"stages"`
}

type workflowReserveArgs struct {
	operation
	StageID          string `json:"stageId"`
	Revision         int64  `json:"revision"`
	PreviousApproval string `json:"previousApproval,omitempty"`
	ExpectedRunID    string `json:"expectedRunId,omitempty"`
}

type workflowReservation struct {
	workflowRunScope
	RunID             string        `json:"runId"`
	WorkflowID        string        `json:"workflowId"`
	WorkflowName      string        `json:"workflowName"`
	Stage             workflowStage `json:"stage"`
	Inputs            []workflowRef `json:"inputs"`
	GenerationResults []workflowRef `json:"generationResults,omitempty"`
	Duplicate         bool          `json:"duplicate,omitempty"`
}

type workflowDecisionArgs struct {
	operation
	StageID string `json:"stageId"`
	RunID   string `json:"runId"`
}

type workflowApproveArgs struct {
	workflowDecisionArgs
	Outputs []workflowRef `json:"outputs"`
}

type workflowFinishArgs struct {
	RunID   string   `json:"runId"`
	Error   string   `json:"error,omitempty"`
	NodeIDs []string `json:"nodeIds,omitempty"`
}

type workflowRunningArgs struct {
	RunID string `json:"runId"`
	workflowFileVersions
}

func validWorkflowSHA256(hash string) bool {
	if len(hash) != 2*sha256.Size || hash != strings.ToLower(hash) {
		return false
	}
	_, err := hex.DecodeString(hash)
	return err == nil
}

var (
	workflowBusy    = &requestError{http.StatusConflict, "工作流已有阶段正在启动或执行"}
	workflowChanged = &requestError{http.StatusConflict, "工作流已更新，请刷新后重试"}
)

func workflowNow() string { return time.Now().UTC().Format(time.RFC3339Nano) }

func (s *Service) executeWorkflow(ctx context.Context, r Request) (any, error) {
	var actor string
	switch r.Action {
	case "workflow_get", "workflow_approve", "workflow_return":
		actor = "human"
	case "workflow_reserve", "workflow_running", "workflow_finish":
		actor = "workflow"
	default:
		return nil, invalid("未知 Workflow 操作：%s", r.Action)
	}
	if r.Actor != actor {
		return nil, &requestError{http.StatusForbidden, "工作流操作身份无效"}
	}
	if r.Action == "workflow_get" {
		if err := decodeData(r.Data, &struct{}{}); err != nil {
			return nil, err
		}
	}
	p, err := s.open(ctx, r.WorkspacePath, false)
	if err != nil {
		return nil, err
	}
	if p == nil {
		if r.Action == "workflow_get" {
			return readWorkflowView(ctx, nil, "")
		}
		return nil, notBound
	}
	if err := p.recoverWorkflow(ctx); err != nil {
		return nil, err
	}
	switch r.Action {
	case "workflow_get":
		tx, err := p.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
		if err != nil {
			return nil, err
		}
		defer tx.Rollback()
		return readWorkflowView(ctx, tx, p.dir)
	case "workflow_reserve":
		var args workflowReserveArgs
		if err := decodeData(r.Data, &args); err != nil {
			return nil, err
		}
		return p.reserveWorkflow(ctx, r, args)
	case "workflow_approve":
		var args workflowApproveArgs
		if err := decodeData(r.Data, &args); err != nil {
			return nil, err
		}
		return p.decideWorkflow(ctx, r, args.workflowDecisionArgs, args.Outputs)
	case "workflow_return":
		var args workflowDecisionArgs
		if err := decodeData(r.Data, &args); err != nil {
			return nil, err
		}
		return p.decideWorkflow(ctx, r, args, nil)
	case "workflow_running":
		var args workflowRunningArgs
		if err := decodeData(r.Data, &args); err != nil {
			return nil, err
		}
		if !validWorkflowSHA256(args.SkillSHA256) || !validWorkflowSHA256(args.HarnessSHA256) {
			return nil, invalid("阶段启动需要有效的 Skill 和 Harness SHA-256")
		}
		return p.updateWorkflowRun(ctx, r, workflowFinishArgs{RunID: args.RunID}, args.workflowFileVersions)
	default:
		var args workflowFinishArgs
		if err := decodeData(r.Data, &args); err != nil {
			return nil, err
		}
		return p.updateWorkflowRun(ctx, r, args, workflowFileVersions{})
	}
}

func readWorkflowRun(row *sql.Row) (workflowRun, error) {
	var run workflowRun
	var record string
	if err := row.Scan(&run.ID, &run.SessionID, &run.Status, &record); err != nil {
		return run, err
	}
	return run, json.Unmarshal([]byte(record), &run)
}

func latestWorkflowRun(ctx context.Context, tx *sql.Tx, stageID string) (workflowRun, error) {
	run, err := readWorkflowRun(tx.QueryRowContext(ctx, `SELECT id,session_id,status,record FROM workflow_runs
		WHERE stage_id=? AND json_extract(record,'$.workflowId')=? ORDER BY rowid DESC LIMIT 1`, stageID, dramaWorkflowID))
	if errors.Is(err, sql.ErrNoRows) {
		return run, nil
	}
	return run, err
}

func readWorkflowView(ctx context.Context, tx *sql.Tx, workspace string) (workflowView, error) {
	view := workflowView{ID: dramaWorkflowID, Name: dramaWorkflowName, Revision: dramaWorkflowRev,
		Stages: make([]workflowStageView, 0, len(dramaWorkflowStages))}
	chainReady, upstreamChanged := tx != nil, false
	var previous workflowApproval
	for _, stage := range dramaWorkflowStages {
		item := workflowStageView{workflowStage: stage, Status: workflowNotStarted}
		if stage.ID == workflowGeneration {
			generation := workflowGenerationView{State: "waiting", Message: "先确认视频节点部署"}
			if chainReady {
				var err error
				generation, _, err = generationProgress(ctx, tx, workspace, previous)
				if err != nil {
					return view, err
				}
			}
			item.Generation = &generation
		}
		if tx != nil {
			run, err := latestWorkflowRun(ctx, tx, stage.ID)
			if err != nil {
				return view, err
			}
			if run.ID != "" {
				item.Status, item.RunID = run.Status, run.ID
				item.SessionID, item.ReservedAt, item.StartedAt, item.FinishedAt = run.SessionID, run.ReservedAt, run.StartedAt, run.FinishedAt
				item.SkillID, item.workflowRunScope, item.workflowFileVersions = run.Stage.Skill, run.workflowRunScope, run.workflowFileVersions
				item.Inputs, item.Outputs, item.Approvals, item.Error = run.Inputs, run.Outputs, run.Approvals, run.Error
				if run.Status == workflowStarting {
					item.Status, item.Pending = workflowNotStarted, true
				} else if (upstreamChanged || run.PreviousApproval != previous.ID) && run.Status != workflowRunning {
					item.Status = workflowStale
					upstreamChanged = true
				}
			}
			if stage.ID == workflowGeneration && item.Status == workflowReview {
				err := checkGenerationResults(ctx, tx, workspace, run)
				if err != nil && err != generationResultChanged {
					return view, err
				}
				item.NeedsRerun = err == generationResultChanged
			}
			approval := run.lastApproval()
			if approval.ID != "" {
				item.ApprovalID, item.Outputs = approval.ID, approval.Outputs
				if !upstreamChanged {
					if err := checkWorkflowApproval(ctx, tx, workspace, run, approval); err != nil {
						var changed *requestError
						if !errors.As(err, &changed) {
							return view, err
						}
						item.NeedsReview = run.Status == workflowApproved
						upstreamChanged = true
					}
				}
			}
			chainReady = chainReady && !upstreamChanged && run.Status == workflowApproved && run.PreviousApproval == previous.ID && approval.ID != ""
			previous = approval
		}
		view.Stages = append(view.Stages, item)
	}
	return view, nil
}

func (run workflowRun) lastApproval() workflowApproval {
	if len(run.Approvals) == 0 {
		return workflowApproval{}
	}
	return run.Approvals[len(run.Approvals)-1]
}

func workflowStageIndex(stageID string) int {
	return slices.IndexFunc(dramaWorkflowStages, func(stage workflowStage) bool { return stage.ID == stageID })
}

func requireWorkflowIdle(ctx context.Context, tx *sql.Tx) error {
	var runID, stageID, sessionID string
	err := tx.QueryRowContext(ctx, `SELECT id,stage_id,session_id FROM workflow_runs
		WHERE status IN ('starting','running') LIMIT 1`).Scan(&runID, &stageID, &sessionID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	return &requestError{http.StatusConflict, fmt.Sprintf("工作流已有阶段正在启动或执行（阶段 %s，Session %s，Run %s）", stageID, sessionID, runID)}
}

func previousWorkflowApproval(ctx context.Context, tx *sql.Tx, workspace string, stages []workflowStage) (workflowApproval, error) {
	var approval workflowApproval
	for _, stage := range stages {
		run, err := latestWorkflowRun(ctx, tx, stage.ID)
		if err != nil {
			return workflowApproval{}, err
		}
		if run.Status != workflowApproved || run.PreviousApproval != approval.ID || run.lastApproval().ID == "" {
			return workflowApproval{}, &requestError{http.StatusConflict, "请先确认上游阶段的最新产物"}
		}
		approval = run.lastApproval()
		if err := checkWorkflowApproval(ctx, tx, workspace, run, approval); err != nil {
			return workflowApproval{}, err
		}
	}
	return approval, nil
}

func (p *project) reserveWorkflow(ctx context.Context, r Request, args workflowReserveArgs) (any, error) {
	var reserved string
	result, err := p.write(ctx, r, args.operation.ID, func(tx *sql.Tx, status Status) (any, error) {
		index := workflowStageIndex(args.StageID)
		if args.Revision != dramaWorkflowRev || index < 0 {
			return nil, workflowChanged
		}
		if err := requireWorkflowIdle(ctx, tx); err != nil {
			return nil, err
		}
		last, err := latestWorkflowRun(ctx, tx, args.StageID)
		if err != nil {
			return nil, err
		}
		if last.ID != args.ExpectedRunID {
			return nil, workflowChanged
		}
		run := workflowRun{ID: uuid.NewString(), SessionID: r.SessionID, WorkflowID: dramaWorkflowID, Stage: dramaWorkflowStages[index],
			workflowRunScope: workflowRunScope{WorkspaceID: status.WorkspaceID, CanvasID: status.CanvasID, DefinitionVersion: dramaWorkflowRev},
			Status:           workflowStarting, ReservedAt: workflowNow(), Inputs: []workflowRef{}}
		approval, err := previousWorkflowApproval(ctx, tx, p.dir, dramaWorkflowStages[:index])
		if err != nil {
			return nil, err
		}
		if approval.ID != args.PreviousApproval {
			return nil, workflowChanged
		}
		if approval.ID != "" {
			run.PreviousApproval, run.Inputs = approval.ID, approval.Outputs
		}
		if run.Stage.ID == workflowGeneration {
			generation, refs, err := generationProgress(ctx, tx, p.dir, approval)
			if err != nil {
				return nil, err
			}
			if generation.State != "ready" {
				return nil, &requestError{http.StatusConflict, generation.Message}
			}
			run.GenerationResults, run.GenerationTasks = refs, generation.TaskIDs
		}
		if err := tx.QueryRowContext(ctx, `SELECT COALESCE(MAX(rowid),0) FROM nodes`).Scan(&run.NodeWatermark); err != nil {
			return nil, err
		}
		release, err := p.tryTaskLock("workflow-active")
		if err != nil {
			return nil, err
		}
		if release == nil {
			return nil, workflowBusy
		}
		p.mu.Lock()
		p.workflowOwner, p.releaseWorkflowLock = run.ID, release
		p.mu.Unlock()
		reserved = run.ID
		record, err := json.Marshal(run)
		if err != nil {
			return nil, err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO workflow_runs VALUES(?,?,?,?,?)`, run.ID, run.Stage.ID, run.SessionID, run.Status, string(record)); err != nil {
			return nil, err
		}
		if _, err := addEvent(ctx, tx, "workflow", []string{run.Stage.ID}); err != nil {
			return nil, err
		}
		return workflowReservation{RunID: run.ID, WorkflowID: dramaWorkflowID, WorkflowName: dramaWorkflowName,
			workflowRunScope: run.workflowRunScope,
			Stage:            run.Stage, Inputs: run.Inputs, GenerationResults: run.GenerationResults}, nil
	})
	if err != nil {
		if reserved != "" {
			p.unlockWorkflow(reserved)
		}
		return nil, err
	}
	if raw, duplicate := result.(json.RawMessage); duplicate {
		var prior workflowReservation
		if err := json.Unmarshal(raw, &prior); err != nil {
			return nil, err
		}
		prior.Duplicate = true
		return prior, nil
	}
	return result, nil
}

func (p *project) workflowChange(ctx context.Context, tx *sql.Tx, id string) (workflowView, error) {
	if _, err := addEvent(ctx, tx, "workflow", []string{id}); err != nil {
		return workflowView{}, err
	}
	return readWorkflowView(ctx, tx, p.dir)
}

func checkWorkflowRefs(ctx context.Context, tx *sql.Tx, refs []workflowRef) error {
	for _, ref := range refs {
		var live bool
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM nodes WHERE id=? AND revision=? AND deleted=0)`,
			ref.ID, ref.Revision).Scan(&live); err != nil {
			return err
		}
		if !live {
			return &requestError{http.StatusConflict, "产物已修改或删除，请打开 Canvas 检查并重新确认版本"}
		}
	}
	return nil
}

func staleWorkflowStages(ctx context.Context, tx *sql.Tx, stages []workflowStage) error {
	for _, stage := range stages {
		if _, err := tx.ExecContext(ctx, `UPDATE workflow_runs SET status='stale'
			WHERE id=(SELECT id FROM workflow_runs WHERE stage_id=? AND json_extract(record,'$.workflowId')=? ORDER BY rowid DESC LIMIT 1)`, stage.ID, dramaWorkflowID); err != nil {
			return err
		}
	}
	return nil
}

func (p *project) decideWorkflow(ctx context.Context, r Request, args workflowDecisionArgs, outputs []workflowRef) (any, error) {
	return p.write(ctx, r, args.operation.ID, func(tx *sql.Tx, _ Status) (any, error) {
		index := workflowStageIndex(args.StageID)
		if index < 0 || args.RunID == "" {
			return nil, workflowChanged
		}
		if err := requireWorkflowIdle(ctx, tx); err != nil {
			return nil, err
		}
		run, err := latestWorkflowRun(ctx, tx, args.StageID)
		if err != nil {
			return nil, err
		}
		if run.ID != args.RunID || run.Status != workflowReview && run.Status != workflowApproved {
			return nil, workflowChanged
		}
		if r.Action == "workflow_return" {
			if run.Status == workflowReview {
				return readWorkflowView(ctx, tx, p.dir)
			}
			run.Status = workflowReview
		} else {
			previous, err := previousWorkflowApproval(ctx, tx, p.dir, dramaWorkflowStages[:index])
			if err != nil {
				return nil, err
			}
			if previous.ID != run.PreviousApproval {
				return nil, workflowChanged
			}
			if len(outputs) == 0 || len(outputs) != len(run.Outputs) {
				return nil, invalid("需要确认当前阶段产物的完整版本列表")
			}
			for i, ref := range outputs {
				if ref.ID != run.Outputs[i].ID || ref.Revision < 1 {
					return nil, invalid("只能确认本轮阶段产物")
				}
			}
			if err := checkWorkflowRefs(ctx, tx, outputs); err != nil {
				return nil, err
			}
			if run.Stage.ID == workflowGeneration {
				if !slices.Equal(outputs, run.GenerationResults) {
					return nil, generationResultChanged
				}
				if err := checkGenerationResults(ctx, tx, p.dir, run); err != nil {
					return nil, err
				}
			}
			if approval := run.lastApproval(); !slices.Equal(approval.Outputs, outputs) {
				if run.Stage.ID == workflowDeployment {
					if _, err := deploymentDrafts(ctx, tx, outputs); err != nil {
						return nil, err
					}
				}
				run.Approvals = append(run.Approvals, workflowApproval{
					ID: uuid.NewString(), SessionID: r.SessionID, At: workflowNow(), Outputs: outputs,
				})
				if err := staleWorkflowStages(ctx, tx, dramaWorkflowStages[index+1:]); err != nil {
					return nil, err
				}
			} else if run.Status == workflowApproved {
				return readWorkflowView(ctx, tx, p.dir)
			}
			run.Status = workflowApproved
		}
		if err := changeWorkflowRun(ctx, tx, run); err != nil {
			return nil, err
		}
		return p.workflowChange(ctx, tx, args.StageID)
	})
}

func changeWorkflowRun(ctx context.Context, tx *sql.Tx, run workflowRun) error {
	record, err := json.Marshal(run)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `UPDATE workflow_runs SET status=?,record=? WHERE id=?`, run.Status, string(record), run.ID)
	return err
}

func (p *project) ownsWorkflow(runID string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.workflowOwner == runID && p.releaseWorkflowLock != nil
}

func (p *project) unlockWorkflow(runID string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.releaseWorkflowLock != nil && (p.workflowOwner == runID || runID == "") {
		p.releaseWorkflowLock()
		p.workflowOwner, p.releaseWorkflowLock = "", nil
	}
}

func (p *project) recoverWorkflow(ctx context.Context) error {
	tx, err := p.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	run, err := readWorkflowRun(tx.QueryRowContext(ctx, `SELECT id,session_id,status,record FROM workflow_runs
		WHERE status IN ('starting','running') LIMIT 1`))
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if p.ownsWorkflow(run.ID) {
		if run.Status != workflowStarting {
			return nil
		}
		reserved, err := time.Parse(time.RFC3339Nano, run.ReservedAt)
		if err != nil || time.Since(reserved) < workflowStartTimeout {
			return err
		}
		run.Status, run.Error, run.FinishedAt = workflowFailed, "DSH 未及时启动阶段。请检查原生会话后重试。", workflowNow()
		if err := p.commitWorkflowRun(ctx, tx, run); err != nil {
			return err
		}
		p.unlockWorkflow(run.ID)
		return nil
	}
	release, err := p.tryTaskLock("workflow-active")
	if err != nil || release == nil {
		return err
	}
	defer release()
	run.Status, run.Error, run.FinishedAt = workflowFailed, "DSH Host 已中断，阶段结果未确认。请检查 Canvas 后手动重试。", workflowNow()
	return p.commitWorkflowRun(ctx, tx, run)
}

func (p *project) updateWorkflowRun(ctx context.Context, r Request, args workflowFinishArgs, versions workflowFileVersions) (any, error) {
	tx, err := p.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	run, err := readWorkflowRun(tx.QueryRowContext(ctx, `SELECT id,session_id,status,record FROM workflow_runs WHERE id=?`, args.RunID))
	if errors.Is(err, sql.ErrNoRows) || err == nil && (run.SessionID != r.SessionID || run.WorkflowID != dramaWorkflowID ||
		run.WorkspaceID != "" && run.WorkspaceID != r.WorkspaceID) {
		return nil, &requestError{http.StatusForbidden, "工作流执行记录与当前 Session 不匹配"}
	}
	if err != nil {
		return nil, err
	}
	if run.Status != workflowStarting && run.Status != workflowRunning {
		if r.Action == "workflow_running" {
			return nil, workflowChanged
		}
		return map[string]string{"status": run.Status}, nil
	}
	if !p.ownsWorkflow(run.ID) {
		return nil, workflowChanged
	}
	if r.Action == "workflow_running" {
		if run.Status == workflowRunning {
			if run.workflowFileVersions != versions {
				return nil, workflowChanged
			}
			return map[string]string{"status": run.Status}, nil
		}
		status, err := getStatus(ctx, tx, r)
		if err != nil {
			return nil, err
		}
		if !status.Connected {
			return nil, notBound
		}
		if status.CanvasID != run.CanvasID {
			return nil, workflowChanged
		}
		if err := checkWorkflowRunInputs(ctx, tx, p.dir, run); err != nil {
			return nil, err
		}
		run.Status, run.StartedAt, run.workflowFileVersions = workflowRunning, workflowNow(), versions
	} else {
		if err := finishWorkflow(ctx, tx, p.dir, &run, args); err != nil {
			return nil, err
		}
	}
	if err := p.commitWorkflowRun(ctx, tx, run); err != nil {
		return nil, err
	}
	if r.Action == "workflow_finish" {
		p.unlockWorkflow(run.ID)
	}
	return map[string]string{"status": run.Status}, nil
}

func (p *project) commitWorkflowRun(ctx context.Context, tx *sql.Tx, run workflowRun) error {
	if err := changeWorkflowRun(ctx, tx, run); err != nil {
		return err
	}
	if _, err := addEvent(ctx, tx, "workflow", []string{run.Stage.ID}); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	p.notify()
	return nil
}

func finishWorkflow(ctx context.Context, tx *sql.Tx, workspace string, run *workflowRun, args workflowFinishArgs) error {
	run.FinishedAt = workflowNow()
	run.Error = strings.TrimSpace(args.Error)
	if reason := []rune(run.Error); len(reason) > 2000 {
		run.Error = string(reason[:2000])
	}
	if run.Error == "" && run.Status != workflowRunning {
		run.Error = "DSH 未确认阶段启动。"
	}
	if run.Error != "" {
		run.Status = workflowFailed
		return nil
	}
	err := checkWorkflowRunInputs(ctx, tx, workspace, *run)
	var outputs []workflowRef
	if err == nil {
		if run.Stage.ID == workflowGeneration {
			outputs = run.GenerationResults
		} else {
			outputs, err = readWorkflowOutputs(ctx, tx, *run, args.NodeIDs)
			if err == nil && run.Stage.ID == workflowDeployment {
				_, err = deploymentDrafts(ctx, tx, outputs)
			}
		}
	}
	var known *requestError
	if errors.As(err, &known) {
		run.Status, run.Error = workflowFailed, known.text
		return nil
	}
	if err != nil {
		return err
	}
	run.Outputs, run.Status = outputs, workflowReview
	return nil
}

func checkWorkflowRunInputs(ctx context.Context, tx *sql.Tx, workspace string, run workflowRun) error {
	index := workflowStageIndex(run.Stage.ID)
	if index < 0 {
		return workflowChanged
	}
	previous, err := previousWorkflowApproval(ctx, tx, workspace, dramaWorkflowStages[:index])
	if err != nil {
		return err
	}
	if run.PreviousApproval != previous.ID || !slices.Equal(run.Inputs, previous.Outputs) {
		return workflowChanged
	}
	if run.Stage.ID == workflowGeneration {
		return checkGenerationResults(ctx, tx, workspace, run)
	}
	return nil
}

func checkWorkflowApproval(ctx context.Context, tx *sql.Tx, workspace string, run workflowRun, approval workflowApproval) error {
	if run.Stage.ID == workflowGeneration {
		return checkGenerationResults(ctx, tx, workspace, run)
	}
	return checkWorkflowRefs(ctx, tx, approval.Outputs)
}

func readWorkflowOutputs(ctx context.Context, tx *sql.Tx, run workflowRun, ids []string) ([]workflowRef, error) {
	if len(ids) == 0 || len(ids) > maxWorkflowOutputs {
		return nil, invalid("DSH 阶段需要通过 drama_append 创建 1–%d 个可验收节点", maxWorkflowOutputs)
	}
	refs := make([]workflowRef, 0, len(ids))
	seen := make(map[string]bool, len(ids))
	for _, id := range ids {
		if seen[id] {
			continue
		}
		var revision int64
		err := tx.QueryRowContext(ctx, `SELECT revision FROM nodes WHERE id=? AND deleted=0 AND created_by=? AND rowid>?`,
			id, run.SessionID, run.NodeWatermark).Scan(&revision)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, invalid("工作流产物必须是本轮 Agent 新增且仍存在的 Canvas 节点")
		}
		if err != nil {
			return nil, err
		}
		seen[id] = true
		refs = append(refs, workflowRef{ID: id, Revision: revision})
	}
	return refs, nil
}
