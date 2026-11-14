package studio

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
)

var (
	humanWriteOnly      = &requestError{http.StatusForbidden, "只有通过 DSH Web 的人工操作可以修改已有节点或连线"}
	workspaceBusy       = &requestError{http.StatusLocked, "画布正在被 Agent 或生成任务使用，暂不能执行此操作。"}
	activityUnavailable = &requestError{http.StatusServiceUnavailable, "无法核实 DSH Agent 活动，暂不能修改或删除。"}
	revisionConflict    = &requestError{http.StatusConflict, "节点已更新，请重新打开编辑。"}
)

// SetHumanWriteCheck installs the private Host activity check before serving IPC.
func (s *Service) SetHumanWriteCheck(check func(ctx context.Context, workspaceID, sessionID string, connected []string) (bool, error)) {
	s.humanWriteCheck = check
}

type connectedSessionsResult struct {
	SessionIDs []string `json:"sessionIds"`
}

func boundSessionIDs(ctx context.Context, db interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}) ([]string, error) {
	rows, err := db.QueryContext(ctx, "SELECT session_id FROM session_bindings WHERE connected=1 ORDER BY session_id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func migrateNodeFields(ctx context.Context, tx *sql.Tx) error {
	rows, err := tx.QueryContext(ctx, "SELECT name FROM pragma_table_info('nodes')")
	if err != nil {
		return err
	}
	columns := make(map[string]bool)
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			rows.Close()
			return err
		}
		columns[name] = true
	}
	if err := errors.Join(rows.Err(), rows.Close()); err != nil {
		return err
	}
	if !columns["revision"] {
		if _, err := tx.ExecContext(ctx, "ALTER TABLE nodes ADD COLUMN revision INTEGER NOT NULL DEFAULT 1"); err != nil {
			return err
		}
	}
	if !columns["deleted"] {
		_, err = tx.ExecContext(ctx, "ALTER TABLE nodes ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0")
	}
	return err
}

type nodeRevisionArgs struct {
	operation
	ID       string `json:"id"`
	Revision int64  `json:"revision"`
}

type updateNodeArgs struct {
	nodeRevisionArgs
	EpisodeID        string          `json:"episodeId"`
	SceneID          string          `json:"sceneId"`
	ShotID           string          `json:"shotId"`
	Content          json.RawMessage `json:"content"`
	ReferenceSources *[]string       `json:"referenceSources,omitempty"`
}

type changeEdgeArgs struct {
	operation
	Source    string `json:"source"`
	Target    string `json:"target"`
	NewSource string `json:"newSource,omitempty"`
	Revision  int64  `json:"revision"`
}

type editResult struct {
	ID        string `json:"id"`
	Revision  int64  `json:"revision"`
	EventSeq  int64  `json:"eventSeq"`
	Deleted   bool   `json:"deleted,omitempty"`
	Tombstone bool   `json:"tombstone,omitempty"`
}

func (s *Service) humanWrite(ctx context.Context, p *project, r Request) (any, error) {
	var affected []string
	write := func(opID string, apply func(*sql.Tx, Status) (any, error)) (any, error) {
		return p.writeChecked(ctx, r, opID, apply, func(tx *sql.Tx) error {
			return s.checkCanvasMutation(ctx, tx, r, affected)
		})
	}
	switch r.Action {
	case "update_node":
		var args updateNodeArgs
		if err := decodeData(r.Data, &args); err != nil {
			return nil, err
		}
		affected = []string{args.ID}
		return write(args.operation.ID, func(tx *sql.Tx, _ Status) (any, error) {
			return updateNode(ctx, tx, args)
		})
	case "delete_node":
		var args nodeRevisionArgs
		if err := decodeData(r.Data, &args); err != nil {
			return nil, err
		}
		return write(args.operation.ID, func(tx *sql.Tx, _ Status) (any, error) {
			result, ids, err := changeCanvas(ctx, tx, canvasChangeArgs{Nodes: []canvasNodeVersion{{ID: args.ID, Revision: args.Revision}}}, false)
			affected = ids
			return editResult{ID: args.ID, Revision: args.Revision + 1, EventSeq: result.EventSeq, Deleted: true, Tombstone: true}, err
		})
	case "canvas_delete", "canvas_restore":
		var args canvasChangeArgs
		if err := decodeData(r.Data, &args); err != nil {
			return nil, err
		}
		return write(args.operation.ID, func(tx *sql.Tx, _ Status) (any, error) {
			result, ids, err := changeCanvas(ctx, tx, args, r.Action == "canvas_restore")
			affected = ids
			return result, err
		})
	default:
		var args changeEdgeArgs
		if err := decodeData(r.Data, &args); err != nil {
			return nil, err
		}
		if args.Source == "" || args.Source == args.NewSource || args.Target == args.NewSource ||
			(r.Action == "update_edge") != (args.NewSource != "") {
			return nil, invalid("需要有效的引用来源、目标和替换来源")
		}
		affected = []string{args.Target}
		return write(args.operation.ID, func(tx *sql.Tx, _ Status) (any, error) {
			return changeEdge(ctx, tx, args)
		})
	}
}

func (s *Service) checkCanvasMutation(ctx context.Context, tx *sql.Tx, r Request, nodeIDs []string) error {
	if len(nodeIDs) == 0 {
		return nil
	}
	locked, err := taskLockedNodes(ctx, tx)
	if err != nil {
		return err
	}
	for _, id := range nodeIDs {
		if slices.Contains(locked, id) {
			return workspaceBusy
		}
	}
	// A new reference may update its target's order without editing an existing edge.
	if r.Action == "append" {
		return nil
	}
	if s.humanWriteCheck == nil {
		return activityUnavailable
	}
	sessions, err := boundSessionIDs(ctx, tx)
	if err != nil {
		return err
	}
	// Sample native Agent access at commit while SQLite holds its writer lock.
	allowed, err := s.humanWriteCheck(ctx, r.WorkspaceID, r.SessionID, sessions)
	if err != nil {
		return activityUnavailable
	}
	if !allowed {
		return workspaceBusy
	}
	return nil
}

func editableNode(ctx context.Context, tx *sql.Tx, id string, revision int64) (string, string, error) {
	if id == "" || revision < 1 {
		return "", "", invalid("需要节点 ID 和当前 revision")
	}
	var kind, content string
	var current int64
	err := tx.QueryRowContext(ctx, "SELECT type,content,revision FROM nodes WHERE id=? AND deleted=0", id).Scan(&kind, &content, &current)
	if errors.Is(err, sql.ErrNoRows) {
		return "", "", &requestError{http.StatusNotFound, "节点不存在或已删除"}
	}
	if err == nil && current != revision {
		return "", "", revisionConflict
	}
	return kind, content, err
}

func updateNode(ctx context.Context, tx *sql.Tx, args updateNodeArgs) (editResult, error) {
	kind, raw, err := editableNode(ctx, tx, args.ID, args.Revision)
	if err != nil {
		return editResult{}, err
	}
	var previous, content map[string]json.RawMessage
	if err := json.Unmarshal([]byte(raw), &previous); err != nil {
		return editResult{}, err
	}
	if err := json.Unmarshal(args.Content, &content); err != nil || content == nil {
		return editResult{}, invalid("节点 content 必须是 JSON 对象")
	}
	preserveContentField(content, previous, "providerTaskId")
	if len(content["promptDoc"]) > 0 && bytes.Equal(previous["promptDoc"], content["promptDoc"]) {
		var oldPrompt, newPrompt string
		if kind == "prompt" {
			oldPrompt, newPrompt = nodeText(json.RawMessage(raw)), nodeText(args.Content)
		} else {
			_ = json.Unmarshal(previous["prompt"], &oldPrompt)
			if json.Unmarshal(content["prompt"], &newPrompt) != nil {
				newPrompt = oldPrompt
			}
		}
		if oldPrompt != newPrompt {
			delete(content, "promptDoc")
		}
	}
	if args.ReferenceSources != nil {
		if kind != "video" && kind != "shot" && kind != "image" {
			return editResult{}, invalid("只有图片、视频和镜头支持在节点编辑中替换有序输入")
		}
		setOrderedSources(content, *args.ReferenceSources)
	} else {
		preserveContentField(content, previous, "mixedListOrder")
	}
	encoded, err := json.Marshal(content)
	if err != nil {
		return editResult{}, err
	}
	if err := validateNode(NodeInput{ID: args.ID, Type: kind, Content: encoded}); err != nil {
		return editResult{}, err
	}
	encoded, err = normalizePromptDoc(kind, encoded)
	if err != nil {
		return editResult{}, err
	}

	if args.ReferenceSources != nil {
		if err := replaceReferences(ctx, tx, args.ID, kind, orderedSources(previous), *args.ReferenceSources); err != nil {
			return editResult{}, err
		}
	}
	if _, err := tx.ExecContext(ctx, `UPDATE nodes SET episode_id=?,scene_id=?,shot_id=?,content=?,revision=revision+1 WHERE id=?`,
		args.EpisodeID, args.SceneID, args.ShotID, string(encoded), args.ID); err != nil {
		return editResult{}, err
	}
	if kind == "video" {
		if err := validateVideo(ctx, tx, args.ID, true); err != nil {
			return editResult{}, err
		}
	}
	if isVideoMedia(kind) {
		if err := validateDependentVideos(ctx, tx, args.ID); err != nil {
			return editResult{}, err
		}
	}
	seq, err := addEvent(ctx, tx, "update", []string{args.ID})
	return editResult{ID: args.ID, Revision: args.Revision + 1, EventSeq: seq}, err
}

func preserveContentField(content, previous map[string]json.RawMessage, name string) {
	if value, ok := previous[name]; ok {
		content[name] = value
	} else {
		delete(content, name)
	}
}

func orderedSources(content map[string]json.RawMessage) []string {
	var sources []string
	if json.Unmarshal(content["mixedListOrder"], &sources) != nil {
		return nil
	}
	return sources
}

func setOrderedSources(content map[string]json.RawMessage, sources []string) {
	if len(sources) == 0 {
		delete(content, "mixedListOrder")
		return
	}
	content["mixedListOrder"], _ = json.Marshal(sources)
}

func relatedNodeIDs(ctx context.Context, tx *sql.Tx, statement, id string) ([]string, error) {
	rows, err := tx.QueryContext(ctx, statement, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func replaceReferences(ctx context.Context, tx *sql.Tx, target, kind string, previous, next []string) error {
	edges, err := relatedNodeIDs(ctx, tx, "SELECT source FROM edges WHERE target=?", target)
	if err != nil {
		return err
	}
	keep := make(map[string]bool, len(next))
	for _, source := range next {
		if source == target || keep[source] {
			return invalid("素材引用不能重复或指向当前节点")
		}
		keep[source] = true
		connected := slices.Contains(edges, source)
		if connected && kind == "shot" && slices.Contains(previous, source) {
			continue
		}
		if err := validateReferenceSource(ctx, tx, source, kind); err != nil {
			return err
		}
		if !connected {
			if _, err := tx.ExecContext(ctx, "INSERT INTO edges(source,target) VALUES(?,?)", source, target); err != nil {
				return err
			}
		}
	}
	for _, source := range edges {
		if !keep[source] && (kind == "video" || kind == "image" || slices.Contains(previous, source)) {
			if _, err := tx.ExecContext(ctx, "DELETE FROM edges WHERE source=? AND target=?", source, target); err != nil {
				return err
			}
		}
	}
	return nil
}

func validateReferenceSource(ctx context.Context, tx *sql.Tx, id, targetType string) error {
	kind, err := nodeType(ctx, tx, id)
	if err != nil {
		return err
	}
	if targetType == "image" && (kind == "image" || isTextNode(kind)) ||
		targetType != "image" && isVideoMedia(kind) {
		return nil
	}
	return invalid("当前节点不接受 %s 类型的引用", kind)
}

func validateDependentVideos(ctx context.Context, tx *sql.Tx, id string) error {
	targets, err := relatedNodeIDs(ctx, tx, `SELECT target FROM edges JOIN nodes ON nodes.id=target
		WHERE source=? AND type='video' AND deleted=0`, id)
	if err != nil {
		return err
	}
	for _, target := range targets {
		if err := validateVideo(ctx, tx, target, true); err != nil {
			return err
		}
	}
	return nil
}

func changeEdge(ctx context.Context, tx *sql.Tx, args changeEdgeArgs) (editResult, error) {
	kind, raw, err := editableNode(ctx, tx, args.Target, args.Revision)
	if err != nil {
		return editResult{}, err
	}
	sources, err := relatedNodeIDs(ctx, tx, "SELECT source FROM edges WHERE target=?", args.Target)
	if err != nil {
		return editResult{}, err
	}
	if !slices.Contains(sources, args.Source) {
		return editResult{}, &requestError{http.StatusNotFound, "引用连线已不存在"}
	}
	var content map[string]json.RawMessage
	if err := json.Unmarshal([]byte(raw), &content); err != nil {
		return editResult{}, err
	}
	order := orderedSources(content)
	slot := slices.Index(order, args.Source)
	if args.NewSource == "" {
		_, err = tx.ExecContext(ctx, "DELETE FROM edges WHERE source=? AND target=?", args.Source, args.Target)
		if slot >= 0 {
			order = slices.Delete(order, slot, slot+1)
		}
	} else {
		if slices.Contains(sources, args.NewSource) {
			return editResult{}, &requestError{http.StatusConflict, "新的引用连线已存在"}
		}
		if kind == "video" || slot >= 0 {
			err = validateReferenceSource(ctx, tx, args.NewSource, kind)
		} else {
			_, err = nodeType(ctx, tx, args.NewSource)
		}
		if err != nil {
			return editResult{}, err
		}
		_, err = tx.ExecContext(ctx, "UPDATE edges SET source=? WHERE source=? AND target=?", args.NewSource, args.Source, args.Target)
		if slot >= 0 {
			order[slot] = args.NewSource
		}
	}
	if err != nil {
		return editResult{}, err
	}
	if slot >= 0 {
		setOrderedSources(content, order)
		encoded, err := json.Marshal(content)
		if err != nil {
			return editResult{}, err
		}
		raw = string(encoded)
	}
	if _, err := tx.ExecContext(ctx, "UPDATE nodes SET content=?,revision=revision+1 WHERE id=?", raw, args.Target); err != nil {
		return editResult{}, err
	}
	if kind == "video" {
		if err := validateVideo(ctx, tx, args.Target, args.NewSource != ""); err != nil {
			return editResult{}, err
		}
	}
	ids := []string{args.Source, args.Target}
	if args.NewSource != "" {
		ids = append(ids, args.NewSource)
	}
	seq, err := addEvent(ctx, tx, "update", ids)
	return editResult{ID: args.Target, Revision: args.Revision + 1, EventSeq: seq}, err
}
