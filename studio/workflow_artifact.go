package studio

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
)

type workflowArtifactRef struct {
	ArtifactID string `json:"artifactId"`
	Version    int64  `json:"version"`
}

type workflowArtifactNotes struct {
	Summary            string   `json:"summary,omitempty"`
	ConfirmedDecisions []string `json:"confirmedDecisions,omitempty"`
	Constraints        []string `json:"constraints,omitempty"`
}

type workflowArtifact struct {
	workflowArtifactRef
	workflowArtifactNotes
	workflowFileVersions
	StageID   string `json:"stageId"`
	SessionID string `json:"sessionId"`
	Title     string `json:"title"`
	Kind      string `json:"kind"`
	Content   string `json:"content,omitempty"`
	NodeID    string `json:"nodeId,omitempty"`
	Node      *Node  `json:"node,omitempty"`
	CreatedAt string `json:"createdAt"`
	HandedOff bool   `json:"handedOff,omitempty"`
	inputKey  string
}

type workflowSaveArtifactArgs struct {
	operation
	workflowArtifactNotes
	RunID           string `json:"runId"`
	ArtifactID      string `json:"artifactId,omitempty"`
	ExpectedVersion int64  `json:"expectedVersion,omitempty"`
	Title           string `json:"title"`
	Content         string `json:"content,omitempty"`
	NodeID          string `json:"nodeId,omitempty"`
}

func (a workflowArtifactNotes) valid() bool {
	if utf8.RuneCountInString(a.Summary) > 2000 || len(a.ConfirmedDecisions) > 40 || len(a.Constraints) > 40 {
		return false
	}
	for _, entries := range [][]string{a.ConfirmedDecisions, a.Constraints} {
		for _, entry := range entries {
			if strings.TrimSpace(entry) == "" || utf8.RuneCountInString(entry) > 1000 {
				return false
			}
		}
	}
	return true
}

func (p *project) saveWorkflowArtifact(ctx context.Context, r Request, args workflowSaveArtifactArgs) (any, error) {
	title, content := strings.TrimSpace(args.Title), strings.TrimSpace(args.Content)
	if args.RunID == "" || title == "" || utf8.RuneCountInString(title) > 160 ||
		(content == "") == (args.NodeID == "") || len(content) > 128<<10 ||
		args.ExpectedVersion < 0 || !args.workflowArtifactNotes.valid() {
		return nil, invalid("阶段产物需要标题、非空文档或单个 Canvas 引用，以及有效的版本和摘要")
	}
	return p.write(ctx, r, args.operation.ID, func(tx *sql.Tx, status Status) (any, error) {
		turn, err := readWorkflowTurn(ctx, tx, args.RunID)
		if errors.Is(err, sql.ErrNoRows) || err == nil && (turn.sessionID != r.SessionID || turn.status != workflowRunning) {
			return nil, workflowForbidden
		}
		if err != nil {
			return nil, err
		}
		if !p.ownsWorkflowTurn(turn.id) {
			return nil, workflowChanged
		}
		session, err := readWorkflowSession(ctx, tx, r.SessionID)
		if err != nil {
			return nil, err
		}
		if turn.activation != session.Activation || turn.snapshotID == "" || turn.snapshotID != session.SnapshotID {
			return nil, workflowChanged
		}
		artifact := workflowArtifact{workflowArtifactNotes: args.workflowArtifactNotes, workflowFileVersions: turn.workflowFileVersions,
			StageID: turn.stageID, SessionID: r.SessionID, Title: title, Kind: "document", Content: content,
			CreatedAt: workflowNow(), inputKey: turn.inputKey}
		if args.NodeID != "" {
			if !status.Connected {
				return nil, notBound
			}
			node, err := readWorkflowNode(ctx, tx, args.NodeID)
			if err != nil {
				return nil, err
			}
			artifact.NodeID, artifact.Node, artifact.Kind = node.ID, &node, workflowNodeKind(node.Type)
		}
		if args.ArtifactID != "" {
			prior, err := scanWorkflowArtifact(tx.QueryRowContext(ctx, `SELECT record,input_key FROM workflow_artifacts
				WHERE id=? AND session_id=? AND stage_id=? ORDER BY version DESC LIMIT 1`, args.ArtifactID, r.SessionID, turn.stageID))
			if errors.Is(err, sql.ErrNoRows) {
				return nil, &requestError{http.StatusNotFound, "当前 Session 和阶段没有该产物"}
			}
			if err != nil {
				return nil, err
			}
			if prior.Kind != artifact.Kind {
				return nil, invalid("同一产物的新版需要保持产物类型")
			}
			if args.ExpectedVersion != 0 && args.ExpectedVersion != prior.Version {
				return nil, workflowChanged
			}
			if artifact.ConfirmedDecisions == nil {
				artifact.ConfirmedDecisions = prior.ConfirmedDecisions
			}
			if artifact.Constraints == nil {
				artifact.Constraints = prior.Constraints
			}
			artifact.ArtifactID, artifact.Version = args.ArtifactID, prior.Version+1
		} else {
			if args.ExpectedVersion != 0 {
				return nil, invalid("更新产物版本需要产物 ID")
			}
			var total int
			if err := tx.QueryRowContext(ctx, `SELECT count(DISTINCT id) FROM workflow_artifacts WHERE session_id=? AND stage_id=?`,
				r.SessionID, turn.stageID).Scan(&total); err != nil {
				return nil, err
			}
			if total >= maxWorkflowOutputs {
				return nil, invalid("当前 Session 阶段产物已达 %d 项，请更新已有产物", maxWorkflowOutputs)
			}
			artifact.ArtifactID, artifact.Version = uuid.NewString(), 1
		}
		if err := insertWorkflowArtifact(ctx, tx, artifact); err != nil {
			return nil, err
		}
		if _, err := addEvent(ctx, tx, "workflow", []string{artifact.StageID}); err != nil {
			return nil, err
		}
		return artifact, nil
	})
}

func readWorkflowNode(ctx context.Context, tx *sql.Tx, id string) (Node, error) {
	node, err := scanNode(tx.QueryRowContext(ctx, "SELECT "+nodeColumns+" FROM nodes WHERE id=? AND deleted=0", id))
	if errors.Is(err, sql.ErrNoRows) {
		return node, &requestError{http.StatusNotFound, "Canvas 节点不存在或已删除"}
	}
	return node, err
}

func workflowNodeKind(kind string) string {
	switch kind {
	case "image", "video", "audio":
		return kind
	default:
		return "node"
	}
}

func insertWorkflowArtifact(ctx context.Context, tx *sql.Tx, artifact workflowArtifact) error {
	body, err := json.Marshal(artifact)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO workflow_artifacts(id,version,stage_id,session_id,input_key,record) VALUES(?,?,?,?,?,?)`,
		artifact.ArtifactID, artifact.Version, artifact.StageID, artifact.SessionID, artifact.inputKey, string(body))
	return err
}

func scanWorkflowArtifact(row interface{ Scan(...any) error }) (workflowArtifact, error) {
	var artifact workflowArtifact
	var body string
	if err := row.Scan(&body, &artifact.inputKey); err != nil {
		return artifact, err
	}
	return artifact, json.Unmarshal([]byte(body), &artifact)
}

func readOwnWorkflowArtifacts(ctx context.Context, tx *sql.Tx, sessionID, stageID string, latestOnly bool) ([]workflowArtifact, error) {
	query := `SELECT record,input_key FROM workflow_artifacts AS a WHERE session_id=? AND (?='' OR stage_id=?)`
	if latestOnly {
		query += ` AND version=(SELECT MAX(version) FROM workflow_artifacts WHERE id=a.id)`
	}
	rows, err := tx.QueryContext(ctx, query+" ORDER BY rowid DESC", sessionID, stageID, stageID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	artifacts := []workflowArtifact{}
	for rows.Next() {
		artifact, err := scanWorkflowArtifact(rows)
		if err != nil {
			return nil, err
		}
		artifacts = append(artifacts, artifact)
	}
	return artifacts, rows.Err()
}

func (p *project) getWorkflowArtifact(ctx context.Context, sessionID string, ref workflowArtifactRef) (workflowArtifact, error) {
	if ref.ArtifactID == "" || ref.Version < 1 {
		return workflowArtifact{}, invalid("需要产物 ID 和版本")
	}
	tx, err := p.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return workflowArtifact{}, err
	}
	defer tx.Rollback()
	var record string
	var pinned bool
	err = tx.QueryRowContext(ctx, `SELECT a.value,h.revision IS NOT NULL FROM workflow_handoffs h, json_each(h.record,'$.artifacts') AS a
		WHERE (h.revision IS NOT NULL OR h.session_id=?) AND json_extract(a.value,'$.artifactId')=? AND json_extract(a.value,'$.version')=?
		ORDER BY h.revision DESC LIMIT 1`, sessionID, ref.ArtifactID, ref.Version).Scan(&record, &pinned)
	if err == nil {
		var item workflowArtifact
		if err := json.Unmarshal([]byte(record), &item); err != nil {
			return item, err
		}
		item.HandedOff = pinned
		return item, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return workflowArtifact{}, err
	}
	item, err := scanWorkflowArtifact(tx.QueryRowContext(ctx, `SELECT record,input_key FROM workflow_artifacts
		WHERE session_id=? AND id=? AND version=?`, sessionID, ref.ArtifactID, ref.Version))
	if errors.Is(err, sql.ErrNoRows) {
		return item, &requestError{http.StatusNotFound, "当前 Session 无权查看该草稿或版本不存在"}
	}
	return item, err
}

func workflowMediaRefs(artifacts []workflowArtifact) []workflowRef {
	refs := make([]workflowRef, 0, len(artifacts))
	for _, a := range artifacts {
		if a.Node != nil {
			refs = append(refs, workflowRef{ID: a.Node.ID, Revision: a.Node.Revision})
		}
	}
	return refs
}
