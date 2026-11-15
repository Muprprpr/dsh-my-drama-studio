package studio

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"os"
)

type workflowGenerationView struct {
	State   string   `json:"state"`
	TaskIDs []string `json:"taskIds,omitempty"`
	Message string   `json:"message,omitempty"`
}

func deploymentDrafts(ctx context.Context, tx *sql.Tx, outputs []workflowRef) ([]workflowRef, error) {
	drafts := make([]workflowRef, 0, len(outputs))
	for _, output := range outputs {
		kind, _, revision, err := submissionNode(ctx, tx, output.ID)
		var invalidDraft *requestError
		if errors.As(err, &invalidDraft) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if kind == "video" && revision == output.Revision {
			drafts = append(drafts, output)
		}
	}
	if len(drafts) == 0 {
		return nil, invalid("视频节点部署需要至少一个已填写完整提示词的 Canvas 视频草稿")
	}
	return drafts, nil
}

var generationResultChanged = &requestError{http.StatusConflict, "视频生成结果或版本已变更，请在 Canvas 检查后重新核对视频生成阶段"}

func generationProgress(ctx context.Context, tx *sql.Tx, workspace string, approval workflowApproval) (workflowGenerationView, []workflowRef, error) {
	view := workflowGenerationView{State: "waiting", Message: "请在 Canvas 对已确认的视频草稿单独授权生成"}
	drafts, err := deploymentDrafts(ctx, tx, approval.Outputs)
	var known *requestError
	if errors.As(err, &known) {
		view.Message = known.text
		return view, nil, nil
	}
	if err != nil {
		return view, nil, err
	}
	root, err := os.OpenRoot(workspace)
	if err != nil {
		return view, nil, err
	}
	defer root.Close()
	var active, failed, uncertain, paused, missingResult bool
	results := make([]workflowRef, 0, len(drafts))
	for _, draft := range drafts {
		var id, state string
		err := tx.QueryRowContext(ctx, `SELECT id,status FROM tasks
			WHERE node_id=? AND type='video' AND json_extract(input,'$.sourceNodeRevision')=?
			AND json_extract(input,'$.manualConfirmation')=1 ORDER BY rowid DESC LIMIT 1`,
			draft.ID, draft.Revision).Scan(&id, &state)
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		if err != nil {
			return view, nil, err
		}
		view.TaskIDs = append(view.TaskIDs, id)
		switch state {
		case "succeeded":
			ref, err := taskVideoResult(ctx, tx, root, id)
			if err == generationResultChanged {
				missingResult = true
				continue
			}
			if err != nil {
				return view, nil, err
			}
			results = append(results, ref)
		case "pending", "submitting", "polling":
			active = true
		case "paused":
			paused = true
		case "uncertain":
			uncertain = true
		default:
			failed = true
		}
	}
	switch {
	case uncertain:
		view.State, view.Message = "failed", "视频任务的提交结果未确认，请在 Canvas 中核对任务记录"
	case paused:
		view.State, view.Message = "processing", "有视频任务暂停，可在 Canvas 任务列表继续查询"
	case active:
		view.State, view.Message = "processing", "已授权的视频正在生成，请在 Canvas 查看任务"
	case missingResult:
		view.State, view.Message = "failed", generationResultChanged.text
	case failed:
		view.State, view.Message = "failed", "视频生成失败或取消，请在 Canvas 检查任务"
	case len(results) == len(drafts):
		view.State, view.Message = "ready", ""
		return view, results, nil
	}
	return view, nil, nil
}

func taskVideoResult(ctx context.Context, tx *sql.Tx, root *os.Root, taskID string) (workflowRef, error) {
	var ref workflowRef
	var outputPath string
	err := tx.QueryRowContext(ctx, `SELECT n.id,n.revision,t.output_path FROM tasks t JOIN nodes n ON n.id=t.result_node_id
		WHERE t.id=? AND t.type='video' AND t.status='succeeded' AND t.provider_id<>'' AND n.type='video' AND n.deleted=0
		AND n.based_on=t.node_id AND t.output_path<>'' AND json_extract(n.content,'$.path')=t.output_path`, taskID).
		Scan(&ref.ID, &ref.Revision, &outputPath)
	if errors.Is(err, sql.ErrNoRows) {
		return ref, generationResultChanged
	}
	if err != nil {
		return ref, err
	}
	info, err := root.Stat(outputPath)
	if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 {
		return ref, generationResultChanged
	}
	return ref, nil
}

func checkGenerationResults(ctx context.Context, tx *sql.Tx, workspace string, run workflowRun) error {
	if len(run.GenerationResults) == 0 || len(run.GenerationResults) != len(run.GenerationTasks) {
		return generationResultChanged
	}
	root, err := os.OpenRoot(workspace)
	if err != nil {
		return err
	}
	defer root.Close()
	for i, taskID := range run.GenerationTasks {
		ref, err := taskVideoResult(ctx, tx, root, taskID)
		if err != nil {
			return err
		}
		if ref != run.GenerationResults[i] {
			return generationResultChanged
		}
	}
	return nil
}
