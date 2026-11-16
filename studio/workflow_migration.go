package studio

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
)

type legacyWorkflowRun struct {
	workflowFileVersions
	WorkflowID  string             `json:"workflowId"`
	WorkspaceID string             `json:"workspaceId"`
	Approvals   []workflowApproval `json:"approvals"`
}

type legacyWorkflowHandoff struct {
	workflowFileVersions
	workflowApproval
	stageID, sessionID, workspaceID string
	stale                           bool
}

func migrateWorkflowProfile(ctx context.Context, tx *sql.Tx) error {
	// Only databases already initialized by the previous Studio version are migrated.
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO workflow_profile(singleton,profile_id,definition_version)
		SELECT 1,?,? WHERE EXISTS(SELECT 1 FROM canvas_meta WHERE singleton=1)
			AND NOT EXISTS(SELECT 1 FROM workflow_migrations WHERE name='workspace-profiles-v1')
		ON CONFLICT(singleton) DO NOTHING`, legacyWorkflowProfile.ID, legacyWorkflowProfile.Version); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `INSERT INTO workflow_migrations VALUES('workspace-profiles-v1') ON CONFLICT DO NOTHING`)
	return err
}

func (p *project) migrateRegisteredWorkflowProfile(ctx context.Context) error {
	tx, err := p.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := initWorkflowProfile(ctx, tx, legacyWorkflowProfile); err != nil {
		return err
	}
	return tx.Commit()
}

func migrateWorkflowActivations(ctx context.Context, tx *sql.Tx) error {
	var migrated bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM workflow_migrations WHERE name='activation-snapshots-v1')`).Scan(&migrated); err != nil || migrated {
		return err
	}
	// Legacy activations keep their known hashes without inventing a body.
	// Even an exited Session may still have an older system surface on disk.
	_, err := tx.ExecContext(ctx, `
		CREATE TABLE workflow_capability_snapshots (id TEXT PRIMARY KEY, record TEXT NOT NULL);
		ALTER TABLE workflow_sessions ADD COLUMN snapshot_id TEXT REFERENCES workflow_capability_snapshots(id);
		ALTER TABLE workflow_sessions ADD COLUMN activated_at TEXT NOT NULL DEFAULT '';
		ALTER TABLE workflow_sessions ADD COLUMN transition_pending INTEGER NOT NULL DEFAULT 0 CHECK(transition_pending IN (0,1));
		ALTER TABLE workflow_turns ADD COLUMN snapshot_id TEXT REFERENCES workflow_capability_snapshots(id);
		UPDATE workflow_sessions SET transition_pending=1 WHERE activation>0;
		INSERT INTO workflow_migrations VALUES('activation-snapshots-v1');
	`)
	return err
}

// Import formal legacy approvals once. Keep the old execution rows for audit;
// active legacy runs lost their Host across the build upgrade.
func migrateWorkflowHandoffs(ctx context.Context, tx *sql.Tx) error {
	var migrated bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM workflow_migrations WHERE name='formal-handoffs-v1')`).Scan(&migrated); err != nil || migrated {
		return err
	}
	rows, err := tx.QueryContext(ctx, `SELECT stage_id,session_id,status,record FROM workflow_runs ORDER BY rowid`)
	if err != nil {
		return err
	}
	var approvals []legacyWorkflowHandoff
	for rows.Next() {
		var stage, session, status, body string
		if err := rows.Scan(&stage, &session, &status, &body); err != nil {
			rows.Close()
			return err
		}
		var run legacyWorkflowRun
		if legacyWorkflowProfile.stageIndex(stage) < 0 {
			continue
		}
		if err := json.Unmarshal([]byte(body), &run); err != nil {
			rows.Close()
			return err
		}
		if run.WorkflowID != dramaWorkflowID {
			continue
		}
		for _, approval := range run.Approvals {
			if approval.ID != "" && len(approval.Outputs) != 0 {
				approvals = append(approvals, legacyWorkflowHandoff{workflowFileVersions: run.workflowFileVersions, workflowApproval: approval,
					stageID: stage, sessionID: session, workspaceID: run.WorkspaceID, stale: status == "stale"})
			}
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	slices.SortStableFunc(approvals, func(a, b legacyWorkflowHandoff) int {
		at, _ := time.Parse(time.RFC3339Nano, a.At)
		bt, _ := time.Parse(time.RFC3339Nano, b.At)
		return at.Compare(bt)
	})
	revision, err := workflowRevision(ctx, tx)
	if err != nil {
		return err
	}
	for _, old := range approvals {
		revision++
		handoff := workflowHandoff{
			workflowFileVersions: old.workflowFileVersions,
			HandoffID:            old.ID, SourceStageID: old.stageID, TargetStageID: legacyWorkflowProfile.nextStage(legacyWorkflowProfile.stageIndex(old.stageID)),
			WorkspaceID: old.workspaceID, SourceSessionID: old.sessionID, SourceRevision: revision,
			CreatedAt: old.At, ConfirmedAt: old.At, ConfirmedDecisions: []string{}, Constraints: []string{},
			Artifacts: make([]workflowArtifact, 0, len(old.Outputs)),
		}
		for _, ref := range old.Outputs {
			artifact, err := legacyWorkflowArtifact(ctx, tx, handoff, ref)
			if err != nil {
				return err
			}
			handoff.Artifacts = append(handoff.Artifacts, artifact)
		}
		fillWorkflowHandoffSummary(&handoff)
		body, err := json.Marshal(handoff)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO workflow_handoffs(id,stage_id,session_id,revision,activation,draft_watermark,stale,record)
			VALUES(?,?,?,?,0,0,?,?) ON CONFLICT(id) DO NOTHING`, handoff.HandoffID, handoff.SourceStageID,
			handoff.SourceSessionID, handoff.SourceRevision, old.stale, string(body)); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, `UPDATE workflow_runs SET status='failed',
		record=json_set(record,'$.error','旧版 Host 已退出，执行未确认。','$.finishedAt',?)
		WHERE status IN ('starting','running') AND json_extract(record,'$.workflowId')=?`,
		workflowNow(), dramaWorkflowID); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO workflow_migrations VALUES('formal-handoffs-v1')`)
	return err
}

func legacyWorkflowArtifact(ctx context.Context, tx *sql.Tx, handoff workflowHandoff, ref workflowRef) (workflowArtifact, error) {
	node, err := scanNode(tx.QueryRowContext(ctx, "SELECT "+nodeColumns+" FROM nodes WHERE id=? AND revision=?", ref.ID, ref.Revision))
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return workflowArtifact{}, err
	}
	artifact := workflowArtifact{
		workflowArtifactRef: workflowArtifactRef{ArtifactID: uuid.NewSHA1(uuid.NameSpaceOID, []byte(handoff.HandoffID+"\x00"+ref.ID)).String(), Version: ref.Revision},
		StageID:             handoff.SourceStageID, SessionID: handoff.SourceSessionID, HandedOff: true,
		Title: "Canvas · " + ref.ID, Kind: "node", NodeID: ref.ID, CreatedAt: handoff.CreatedAt,
	}
	if errors.Is(err, sql.ErrNoRows) {
		// Older versions kept only a reference. Preserve it without presenting
		// the node's current content as the approved historical content.
		node = Node{NodeInput: NodeInput{ID: ref.ID}, Revision: ref.Revision}
		artifact.Summary = "旧版正式记录保留了节点与版本，历史正文不可恢复"
	} else {
		artifact.Kind = workflowNodeKind(node.Type)
		var content struct {
			Title string `json:"title"`
		}
		if json.Unmarshal(node.Content, &content) == nil && strings.TrimSpace(content.Title) != "" {
			artifact.Title = content.Title
		}
	}
	artifact.Node = &node
	return artifact, nil
}
