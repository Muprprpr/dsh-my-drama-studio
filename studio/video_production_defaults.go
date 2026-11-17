package studio

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
)

var workflowVideoAutomaticDisabled = &requestError{http.StatusForbidden, "该工作流视频草稿不在当前有效的正式部署中"}

// pinVideoProductionDefaults captures the Workspace default when the draft is
// created. Tasks and confirmed revisions continue to use the pinned default.
func pinVideoProductionDefaults(ctx context.Context, tx *sql.Tx, turn workflowTurn, nodes []NodeInput) error {
	var spec productionSpec
	var err error
	if turn.id == "" {
		spec, err = readProductionSpec(ctx, tx)
	} else {
		spec, err = productionSpecFromInputKey(turn.inputKey)
	}
	if err != nil {
		return err
	}
	ratio, _ := json.Marshal(spec.AspectRatio)
	for i := range nodes {
		node := &nodes[i]
		if node.Type != "video" {
			continue
		}
		var content map[string]json.RawMessage
		if err := json.Unmarshal(node.Content, &content); err != nil || content == nil {
			return invalid("节点 content 必须是 JSON 对象")
		}
		_, hasRatio := content["productionAspectRatio"]
		_, hasStage := content["workflowDeploymentDraft"]
		delete(content, "productionAspectRatio")
		delete(content, "workflowDeploymentDraft")
		var mode string
		_ = json.Unmarshal(content["mode"], &mode)
		changed := hasRatio || hasStage
		if mode != "asset" && (mode != "" || content["path"] == nil && content["url"] == nil) {
			if spec.AspectRatio != "" {
				content["productionAspectRatio"] = ratio
				changed = true
			}
			if turn.stageID == workflowDeployment {
				content["workflowDeploymentDraft"] = json.RawMessage("true")
				changed = true
			}
		}
		if !changed {
			continue
		}
		node.Content, err = json.Marshal(content)
		if err != nil {
			return err
		}
	}
	return nil
}

func checkAutomaticVideoDraft(ctx context.Context, tx *sql.Tx, snapshot string, draft workflowRef) error {
	var content struct {
		WorkflowDeploymentDraft bool `json:"workflowDeploymentDraft"`
	}
	if err := json.Unmarshal([]byte(snapshot), &content); err != nil {
		return invalid("视频生成节点格式无效")
	}
	if !content.WorkflowDeploymentDraft {
		var recorded bool
		err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM workflow_artifacts
			WHERE stage_id=? AND json_extract(record,'$.nodeId')=?)`, workflowDeployment, draft.ID).Scan(&recorded)
		if err != nil || !recorded {
			return err
		}
	}
	latest, err := readLatestWorkflowHandoffs(ctx, tx)
	if err != nil {
		return err
	}
	deployment := latest[workflowDeployment]
	refs := workflowMediaRefs(deployment.Artifacts)
	if deployment.Stale || !slices.Contains(refs, draft) {
		return workflowVideoAutomaticDisabled
	}
	if err := checkWorkflowRefs(ctx, tx, refs); err != nil {
		var changed *requestError
		if errors.As(err, &changed) {
			return workflowVideoAutomaticDisabled
		}
		return err
	}
	return nil
}
