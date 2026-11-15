package studio

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"

	"github.com/google/uuid"
)

type workflowHandoff struct {
	workflowFileVersions
	HandoffID          string             `json:"handoffId"`
	SourceStageID      string             `json:"sourceStageId"`
	TargetStageID      string             `json:"targetStageId,omitempty"`
	WorkspaceID        string             `json:"workspaceId"`
	SourceSessionID    string             `json:"sourceSessionId"`
	SourceRevision     int64              `json:"sourceRevision"`
	Artifacts          []workflowArtifact `json:"artifacts"`
	Summary            string             `json:"summary"`
	ConfirmedDecisions []string           `json:"confirmedDecisions"`
	Constraints        []string           `json:"constraints"`
	CreatedAt          string             `json:"createdAt"`
	ConfirmedAt        string             `json:"confirmedAt,omitempty"`
	Stale              bool               `json:"stale,omitempty"`
}

type workflowPreviewArgs struct {
	operation
	StageID   string                `json:"stageId,omitempty"`
	Artifacts []workflowArtifactRef `json:"artifacts,omitempty"`
}

type workflowConfirmArgs struct {
	operation
	HandoffID string `json:"handoffId"`
}

func workflowNextStage(index int) string {
	if index+1 >= len(dramaWorkflowStages) {
		return ""
	}
	return dramaWorkflowStages[index+1].ID
}

func readWorkflowHandoffs(ctx context.Context, tx *sql.Tx) ([]workflowHandoff, error) {
	return queryConfirmedWorkflowHandoffs(ctx, tx, false)
}

func readLatestWorkflowHandoffs(ctx context.Context, tx *sql.Tx) (map[string]workflowHandoff, error) {
	history, err := queryConfirmedWorkflowHandoffs(ctx, tx, true)
	return latestWorkflowHandoffs(history), err
}

func queryConfirmedWorkflowHandoffs(ctx context.Context, tx *sql.Tx, latestOnly bool) ([]workflowHandoff, error) {
	query := `SELECT record,stale FROM workflow_handoffs h WHERE revision IS NOT NULL`
	if latestOnly {
		query += ` AND revision=(SELECT MAX(revision) FROM workflow_handoffs WHERE stage_id=h.stage_id)`
	}
	rows, err := tx.QueryContext(ctx, query+" ORDER BY revision DESC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	handoffs := []workflowHandoff{}
	for rows.Next() {
		var body string
		var stale bool
		if err := rows.Scan(&body, &stale); err != nil {
			return nil, err
		}
		var item workflowHandoff
		if err := json.Unmarshal([]byte(body), &item); err != nil {
			return nil, err
		}
		item.Stale = stale
		handoffs = append(handoffs, item)
	}
	return handoffs, rows.Err()
}

func latestWorkflowHandoffs(history []workflowHandoff) map[string]workflowHandoff {
	latest := make(map[string]workflowHandoff, len(dramaWorkflowStages))
	for _, handoff := range history {
		if _, exists := latest[handoff.SourceStageID]; !exists {
			latest[handoff.SourceStageID] = handoff
		}
	}
	return latest
}

func workflowInputs(latest map[string]workflowHandoff, index int) []workflowHandoff {
	result := []workflowHandoff{}
	for _, stage := range dramaWorkflowStages[:index] {
		if handoff, ok := latest[stage.ID]; ok && !handoff.Stale {
			result = append(result, handoff)
		}
	}
	return result
}

func hasWorkflowInput(inputs []workflowHandoff, id string) bool {
	return slices.ContainsFunc(inputs, func(input workflowHandoff) bool { return input.HandoffID == id })
}

func workflowInputKey(inputs []workflowHandoff) string {
	var ids strings.Builder
	for _, input := range inputs {
		fmt.Fprintf(&ids, "%d:%s", len(input.HandoffID), input.HandoffID)
	}
	return ids.String()
}

func requireFreshWorkflowInputs(latest map[string]workflowHandoff, index int) error {
	for _, stage := range dramaWorkflowStages[:index] {
		if latest[stage.ID].Stale {
			return &requestError{http.StatusConflict, fmt.Sprintf("上游阶段「%s」的正式交接已过期，请先更新", stage.Name)}
		}
	}
	return nil
}

func workflowRevision(ctx context.Context, tx *sql.Tx) (int64, error) {
	var revision int64
	err := tx.QueryRowContext(ctx, `SELECT COALESCE(MAX(revision),0) FROM workflow_handoffs`).Scan(&revision)
	return revision, err
}

func workflowDraftWatermark(ctx context.Context, tx *sql.Tx, sessionID, stageID string) (int64, error) {
	var watermark int64
	err := tx.QueryRowContext(ctx, `SELECT COALESCE(MAX(rowid),0) FROM workflow_artifacts WHERE session_id=? AND stage_id=?`,
		sessionID, stageID).Scan(&watermark)
	return watermark, err
}

func (p *project) previewWorkflowHandoff(ctx context.Context, r Request, args workflowPreviewArgs) (any, error) {
	if len(args.Artifacts) > maxWorkflowOutputs {
		return nil, invalid("交接最多包含 %d 项产物", maxWorkflowOutputs)
	}
	return p.write(ctx, r, args.operation.ID, func(tx *sql.Tx, status Status) (any, error) {
		session, err := readWorkflowSession(ctx, tx, r.SessionID)
		if err != nil {
			return nil, err
		}
		index := workflowStageIndex(session.ActiveStageID)
		if index < 0 || session.RunID != "" || args.StageID != "" && args.StageID != session.ActiveStageID {
			return nil, &requestError{http.StatusConflict, "请在当前阶段回合结束后生成交接预览"}
		}
		latest, err := readLatestWorkflowHandoffs(ctx, tx)
		if err != nil {
			return nil, err
		}
		if err := requireFreshWorkflowInputs(latest, index); err != nil {
			return nil, err
		}
		artifacts, err := selectWorkflowArtifacts(ctx, tx, r.SessionID, session.ActiveStageID, args.Artifacts)
		if err != nil {
			return nil, err
		}
		inputKey := workflowInputKey(workflowInputs(latest, index))
		if session.ActiveStageID == workflowGeneration {
			artifacts, err = p.addWorkflowVideoResults(ctx, tx, latest, r.SessionID, session, inputKey, artifacts)
			if err != nil {
				return nil, err
			}
		}
		if len(artifacts) == 0 || len(artifacts) > maxWorkflowOutputs {
			return nil, invalid("交接需要 1–%d 项有效阶段产物", maxWorkflowOutputs)
		}
		for _, artifact := range artifacts {
			if artifact.inputKey != inputKey {
				return nil, &requestError{http.StatusConflict, "草稿使用的上游交接已更新，请在当前阶段保存基于最新交接的版本"}
			}
		}
		if session.ActiveStageID == workflowFinalReview && !slices.ContainsFunc(artifacts, isWorkflowVideo) {
			for _, artifact := range latest[workflowGeneration].Artifacts {
				if isWorkflowVideo(artifact) {
					artifacts = append(artifacts, artifact)
				}
			}
			if len(artifacts) > maxWorkflowOutputs {
				return nil, invalid("交接最多包含 %d 项产物，请缩小产物选择", maxWorkflowOutputs)
			}
		}
		if err := p.checkWorkflowHandoffArtifacts(ctx, tx, latest, session.ActiveStageID, artifacts); err != nil {
			return nil, err
		}
		if previous, ok := latest[session.ActiveStageID]; ok && !previous.Stale && sameWorkflowArtifacts(previous.Artifacts, artifacts) {
			return nil, &requestError{http.StatusConflict, "这些版本已正式交接，请选择更新的产物"}
		}
		revision, err := workflowRevision(ctx, tx)
		if err != nil {
			return nil, err
		}
		watermark, err := workflowDraftWatermark(ctx, tx, r.SessionID, session.ActiveStageID)
		if err != nil {
			return nil, err
		}
		handoff := workflowHandoff{
			workflowFileVersions: session.workflowFileVersions,
			HandoffID:            uuid.NewString(), SourceStageID: session.ActiveStageID, TargetStageID: workflowNextStage(index),
			WorkspaceID: status.WorkspaceID, SourceSessionID: r.SessionID, SourceRevision: revision + 1,
			Artifacts: artifacts, CreatedAt: workflowNow(), ConfirmedDecisions: []string{}, Constraints: []string{},
		}
		fillWorkflowHandoffSummary(&handoff)
		body, err := json.Marshal(handoff)
		if err != nil {
			return nil, err
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO workflow_handoffs(id,stage_id,session_id,activation,draft_watermark,record)
			VALUES(?,?,?,?,?,?)`, handoff.HandoffID, handoff.SourceStageID, r.SessionID, session.activation, watermark, string(body))
		return handoff, err
	})
}

func selectWorkflowArtifacts(ctx context.Context, tx *sql.Tx, sessionID, stageID string, refs []workflowArtifactRef) ([]workflowArtifact, error) {
	if refs == nil {
		return readOwnWorkflowArtifacts(ctx, tx, sessionID, stageID, true)
	}
	out := make([]workflowArtifact, 0, len(refs))
	seen := make(map[string]bool, len(refs))
	for _, ref := range refs {
		if ref.ArtifactID == "" || ref.Version < 1 || seen[ref.ArtifactID] {
			return nil, invalid("每项产物只能选择一个有效版本")
		}
		seen[ref.ArtifactID] = true
		item, err := scanWorkflowArtifact(tx.QueryRowContext(ctx, `SELECT record,input_key FROM workflow_artifacts
			WHERE session_id=? AND stage_id=? AND id=? AND version=?`, sessionID, stageID, ref.ArtifactID, ref.Version))
		if errors.Is(err, sql.ErrNoRows) {
			return nil, &requestError{http.StatusConflict, "只能交接当前 Session 当前阶段的产物"}
		}
		if err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, nil
}

func sameWorkflowArtifacts(left, right []workflowArtifact) bool {
	if len(left) != len(right) {
		return false
	}
	seen := make(map[workflowArtifactRef]bool, len(left))
	for _, artifact := range left {
		seen[artifact.workflowArtifactRef] = true
	}
	for _, artifact := range right {
		if !seen[artifact.workflowArtifactRef] {
			return false
		}
	}
	return true
}

func fillWorkflowHandoffSummary(handoff *workflowHandoff) {
	lines := make([]string, 0, len(handoff.Artifacts))
	for _, item := range handoff.Artifacts {
		summary := strings.TrimSpace(item.Summary)
		if summary == "" && item.Content != "" {
			excerpt := []rune(strings.Join(strings.Fields(item.Content), " "))
			if len(excerpt) > 140 {
				excerpt = append(excerpt[:140], '…')
			}
			summary = string(excerpt)
		}
		label := fmt.Sprintf("%s (V%d)", item.Title, item.Version)
		if summary != "" {
			label += " · " + summary
		}
		lines = append(lines, label)
		handoff.ConfirmedDecisions = appendUniqueNotes(handoff.ConfirmedDecisions, item.ConfirmedDecisions)
		handoff.Constraints = appendUniqueNotes(handoff.Constraints, item.Constraints)
	}
	handoff.Summary = strings.Join(lines, "\n")
}

func appendUniqueNotes(existing, newNotes []string) []string {
	for _, text := range newNotes {
		if text = strings.TrimSpace(text); text != "" && !slices.Contains(existing, text) {
			existing = append(existing, text)
		}
	}
	return existing
}

func (p *project) checkWorkflowHandoffArtifacts(ctx context.Context, tx *sql.Tx, latest map[string]workflowHandoff, stageID string, artifacts []workflowArtifact) error {
	refs := workflowMediaRefs(artifacts)
	if err := checkWorkflowRefs(ctx, tx, refs); err != nil {
		return err
	}
	switch stageID {
	case workflowDeployment:
		_, err := deploymentDrafts(ctx, tx, refs)
		return err
	case workflowGeneration:
		progress, results, err := workflowGenerationProgress(ctx, tx, p.dir, latest)
		if err != nil {
			return err
		}
		if progress.State != "ready" || len(results) != len(refs) {
			return generationResultChanged
		}
		for _, artifact := range results {
			if !slices.Contains(refs, artifact) {
				return generationResultChanged
			}
		}
	case workflowFinalReview:
		return checkFinalWorkflowVideos(ctx, tx, p.dir, latest[workflowGeneration], artifacts)
	}
	return nil
}

func isWorkflowVideo(artifact workflowArtifact) bool {
	return artifact.Kind == "video" && artifact.Node != nil
}

func (p *project) addWorkflowVideoResults(ctx context.Context, tx *sql.Tx, latest map[string]workflowHandoff, sessionID string,
	session workflowSession, inputKey string, artifacts []workflowArtifact) ([]workflowArtifact, error) {
	progress, refs, err := workflowGenerationProgress(ctx, tx, p.dir, latest)
	if err != nil {
		return nil, err
	}
	if progress.State != "ready" {
		return nil, &requestError{http.StatusConflict, progress.Message}
	}
	selected := workflowMediaRefs(artifacts)
	for _, ref := range selected {
		if !slices.Contains(refs, ref) {
			return nil, generationResultChanged
		}
	}
	for i, ref := range refs {
		if slices.Contains(selected, ref) {
			continue
		}
		node, err := readWorkflowNode(ctx, tx, ref.ID)
		if err != nil {
			return nil, err
		}
		item := workflowArtifact{
			workflowArtifactRef: workflowArtifactRef{
				ArtifactID: uuid.NewSHA1(uuid.NameSpaceURL, []byte(sessionID+"\x00"+ref.ID)).String(), Version: ref.Revision,
			},
			workflowFileVersions: session.workflowFileVersions,
			StageID:              workflowGeneration, SessionID: sessionID, Title: fmt.Sprintf("视频生成结果 %d", i+1),
			Kind: "video", NodeID: node.ID, Node: &node, CreatedAt: workflowNow(), inputKey: inputKey,
		}
		artifacts = append(artifacts, item)
	}
	return artifacts, nil
}

func (p *project) confirmWorkflowHandoff(ctx context.Context, r Request, args workflowConfirmArgs) (any, error) {
	if args.HandoffID == "" {
		return nil, invalid("请先生成交接预览")
	}
	return p.write(ctx, r, args.operation.ID, func(tx *sql.Tx, _ Status) (any, error) {
		var record string
		var activation, watermark int64
		err := tx.QueryRowContext(ctx, `SELECT activation,draft_watermark,record FROM workflow_handoffs
			WHERE id=? AND session_id=? AND revision IS NULL`, args.HandoffID, r.SessionID).Scan(&activation, &watermark, &record)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, workflowChanged
		}
		if err != nil {
			return nil, err
		}
		var handoff workflowHandoff
		if err := json.Unmarshal([]byte(record), &handoff); err != nil {
			return nil, err
		}
		session, err := readWorkflowSession(ctx, tx, r.SessionID)
		if err != nil {
			return nil, err
		}
		if session.ActiveStageID != handoff.SourceStageID || session.activation != activation || session.RunID != "" {
			return nil, workflowChanged
		}
		revision, err := workflowRevision(ctx, tx)
		if err != nil {
			return nil, err
		}
		draftWatermark, err := workflowDraftWatermark(ctx, tx, r.SessionID, session.ActiveStageID)
		if err != nil {
			return nil, err
		}
		if handoff.SourceRevision != revision+1 || watermark != draftWatermark {
			return nil, workflowChanged
		}
		index := workflowStageIndex(handoff.SourceStageID)
		if index < 0 || handoff.TargetStageID != workflowNextStage(index) {
			return nil, workflowChanged
		}
		latest, err := readLatestWorkflowHandoffs(ctx, tx)
		if err != nil {
			return nil, err
		}
		if err := requireFreshWorkflowInputs(latest, index); err != nil {
			return nil, err
		}
		if err := p.checkWorkflowHandoffArtifacts(ctx, tx, latest, handoff.SourceStageID, handoff.Artifacts); err != nil {
			return nil, err
		}
		handoff.ConfirmedAt = workflowNow()
		for i := range handoff.Artifacts {
			handoff.Artifacts[i].HandedOff = true
		}
		body, err := json.Marshal(handoff)
		if err != nil {
			return nil, err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE workflow_handoffs SET revision=?,record=? WHERE id=? AND revision IS NULL`,
			handoff.SourceRevision, string(body), handoff.HandoffID); err != nil {
			return nil, err
		}
		for _, downstream := range dramaWorkflowStages[index+1:] {
			if _, err := tx.ExecContext(ctx, `UPDATE workflow_handoffs SET stale=1 WHERE stage_id=? AND revision IS NOT NULL AND stale=0`,
				downstream.ID); err != nil {
				return nil, err
			}
		}
		var pending string
		nextActiveStage := handoff.TargetStageID
		versions := session.workflowFileVersions
		if handoff.TargetStageID != "" {
			pending = handoff.HandoffID
			versions = workflowFileVersions{}
		} else {
			// Final acceptance leaves the Session active on the final stage for further review.
			nextActiveStage = handoff.SourceStageID
		}
		if _, err := tx.ExecContext(ctx, `UPDATE workflow_sessions SET stage_id=?,activation=activation+1,
			skill_sha=?,harness_sha=?,pending_handoff=?,error='' WHERE session_id=?`, nextActiveStage,
			versions.SkillSHA256, versions.HarnessSHA256, pending, r.SessionID); err != nil {
			return nil, err
		}
		if _, err := addEvent(ctx, tx, "workflow", []string{handoff.SourceStageID}); err != nil {
			return nil, err
		}
		return handoff, nil
	})
}
