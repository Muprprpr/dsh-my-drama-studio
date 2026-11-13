package studio

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
)

type NodeInput struct {
	ID        string          `json:"id,omitempty"`
	Type      string          `json:"type"`
	BasedOn   string          `json:"basedOn,omitempty"`
	EpisodeID string          `json:"episodeId"`
	SceneID   string          `json:"sceneId"`
	ShotID    string          `json:"shotId"`
	Content   json.RawMessage `json:"content"`
}

type Node struct {
	NodeInput
	CreatedBySession string `json:"createdBySession"`
	CreatedAt        string `json:"createdAt"`
	Revision         int64  `json:"revision"`
	Deleted          bool   `json:"deleted,omitempty"`
}

type Edge struct {
	Source string `json:"source"`
	Target string `json:"target"`
}

type queryArgs struct {
	ID               string `json:"id"`
	Q                string `json:"q"`
	Type             string `json:"type"`
	EpisodeID        string `json:"episodeId"`
	SceneID          string `json:"sceneId"`
	ShotID           string `json:"shotId"`
	CreatedBySession string `json:"createdBySession"`
	TaskStatus       string `json:"taskStatus"`
	MediaOnly        bool   `json:"mediaOnly"`
	Offset           int    `json:"offset"`
	Limit            int    `json:"limit"`
}

const nodeColumns = "id,type,COALESCE(based_on,''),episode_id,scene_id,shot_id,content,created_by,created_at,revision,deleted"

func scanNode(row interface{ Scan(...any) error }) (Node, error) {
	var n Node
	var content string
	err := row.Scan(&n.ID, &n.Type, &n.BasedOn, &n.EpisodeID, &n.SceneID, &n.ShotID, &content,
		&n.CreatedBySession, &n.CreatedAt, &n.Revision, &n.Deleted)
	n.Content = json.RawMessage(content)
	return n, err
}

type queryResult struct {
	ReferenceNodes []Node          `json:"referenceNodes,omitempty"`
	ResolvedMedia  map[string]Node `json:"resolvedMedia,omitempty"`
	LockedNodeIDs  []string        `json:"lockedNodeIds,omitempty"`
	Nodes          []Node          `json:"nodes"`
	Edges          []Edge          `json:"edges"`
	Status         Status          `json:"status"`
	HasMore        bool            `json:"hasMore"`
}

func (p *project) query(ctx context.Context, r Request) (queryResult, error) {
	var args queryArgs
	if err := decodeData(r.Data, &args); err != nil {
		return queryResult{}, err
	}
	if args.Limit == 0 {
		args.Limit = 100
	}
	if args.Limit < 1 || args.Limit > 100 || args.Offset < 0 {
		return queryResult{}, invalid("limit 必须在 1–100 之间，offset 不得为负")
	}
	tx, err := p.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return queryResult{}, err
	}
	defer tx.Rollback()
	status, err := getStatus(ctx, tx, r)
	if err != nil {
		return queryResult{}, err
	}
	if !status.Connected {
		return queryResult{}, notBound
	}
	result := queryResult{Nodes: make([]Node, 0), Edges: make([]Edge, 0), Status: status}
	query := "SELECT " + nodeColumns + " FROM nodes WHERE 1=1"
	if args.MediaOnly {
		query = "SELECT " + nodeColumns + ` FROM (
			SELECT rowid, *, ROW_NUMBER() OVER (
				PARTITION BY type, COALESCE(NULLIF(json_extract(content,'$.path'),''),json_extract(content,'$.url'))
				ORDER BY deleted,rowid DESC
			) AS asset_rank
			FROM nodes WHERE type IN ('image','video','audio')
				AND (json_extract(content,'$.path') <> '' OR json_extract(content,'$.url') <> '')
		) AS nodes WHERE asset_rank=1`
	} else if args.ID == "" {
		query += " AND deleted=0"
	}
	var params []any
	for _, filter := range []struct{ column, value string }{
		{"id", args.ID}, {"type", args.Type}, {"episode_id", args.EpisodeID}, {"scene_id", args.SceneID},
		{"shot_id", args.ShotID}, {"created_by", args.CreatedBySession},
	} {
		if filter.value != "" {
			query += " AND " + filter.column + "=?"
			params = append(params, filter.value)
		}
	}
	if args.Q != "" {
		query += " AND (instr(lower(id), lower(?)) > 0 OR instr(lower(shot_id), lower(?)) > 0 OR instr(lower(content), lower(?)) > 0)"
		params = append(params, args.Q, args.Q, args.Q)
	}
	if args.TaskStatus != "" {
		var states []string
		switch args.TaskStatus {
		case "queued":
			states = []string{"pending"}
		case "processing":
			states = []string{"submitting", "polling", "paused"}
		case "completed":
			states = []string{"succeeded"}
		case "failed":
			states = []string{"failed", "uncertain"}
		case "cancelled", "pending", "submitting", "polling", "paused", "succeeded", "uncertain":
			states = []string{args.TaskStatus}
		default:
			return queryResult{}, invalid("未知任务状态")
		}
		query += " AND (SELECT status FROM tasks WHERE node_id=nodes.id OR result_node_id=nodes.id ORDER BY rowid DESC LIMIT 1) IN (?" +
			strings.Repeat(",?", len(states)-1) + ")"
		for _, state := range states {
			params = append(params, state)
		}
	}
	rows, err := tx.QueryContext(ctx, query+" ORDER BY rowid DESC LIMIT ? OFFSET ?", append(params, args.Limit+1, args.Offset)...)
	if err != nil {
		return queryResult{}, err
	}
	defer rows.Close()
	ids := make([]any, 0, args.Limit)
	for rows.Next() {
		if len(result.Nodes) == args.Limit {
			result.HasMore = true
			break
		}
		n, err := scanNode(rows)
		if err != nil {
			return queryResult{}, err
		}
		result.Nodes = append(result.Nodes, n)
		ids = append(ids, n.ID)
	}
	if err := rows.Close(); err != nil {
		return queryResult{}, err
	}
	if err := rows.Err(); err != nil || len(ids) == 0 || args.MediaOnly {
		return result, err
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")
	rows, err = tx.QueryContext(ctx, "SELECT source,target FROM edges WHERE target IN ("+placeholders+") ORDER BY rowid", ids...)
	if err != nil {
		return queryResult{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var edge Edge
		if err := rows.Scan(&edge.Source, &edge.Target); err != nil {
			return queryResult{}, err
		}
		result.Edges = append(result.Edges, edge)
	}
	if err := errors.Join(rows.Err(), rows.Close()); err != nil {
		return queryResult{}, err
	}
	if err := addReferenceProjection(ctx, tx, &result); err != nil {
		return queryResult{}, err
	}
	result.LockedNodeIDs, err = taskLockedNodes(ctx, tx)
	return result, err
}

func addReferenceProjection(ctx context.Context, tx *sql.Tx, result *queryResult) error {
	included := make(map[string]bool, len(result.Nodes))
	result.ResolvedMedia = make(map[string]Node)
	for i := range result.Nodes {
		node := &result.Nodes[i]
		included[node.ID] = true
		if node.Type == "image" {
			var content map[string]json.RawMessage
			if err := json.Unmarshal(node.Content, &content); err != nil {
				return err
			}
			previous := orderedSources(content)
			order, err := imageReferenceOrder(ctx, tx, node.ID, previous)
			if err != nil {
				return err
			}
			if !slices.Equal(previous, order) {
				setOrderedSources(content, order)
				node.Content, err = json.Marshal(content)
				if err != nil {
					return err
				}
			}
		}
	}
	for _, edge := range result.Edges {
		if included[edge.Source] {
			continue
		}
		source, err := scanNode(tx.QueryRowContext(ctx, "SELECT "+nodeColumns+" FROM nodes WHERE id=? AND deleted=0", edge.Source))
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		if err != nil {
			return err
		}
		included[source.ID] = true
		result.ReferenceNodes = append(result.ReferenceNodes, source)
	}
	for _, collection := range [][]Node{result.Nodes, result.ReferenceNodes} {
		for _, node := range collection {
			if node.Deleted || !isVideoMedia(node.Type) {
				continue
			}
			resolved, err := resolveMediaNode(ctx, tx, node)
			if err != nil {
				return err
			}
			if resolved.ID != "" && resolved.ID != node.ID {
				result.ResolvedMedia[node.ID] = resolved
			}
		}
	}
	return nil
}

// A connection to a draft follows its latest successful asset. Assets already
// stored directly on a node retain their original identity.
func resolveMediaNode(ctx context.Context, tx *sql.Tx, source Node) (Node, error) {
	var media struct{ Path, URL string }
	if err := json.Unmarshal(source.Content, &media); err != nil {
		return Node{}, err
	}
	if media.Path != "" || media.URL != "" {
		return source, nil
	}
	result, err := scanNode(tx.QueryRowContext(ctx, "SELECT "+nodeColumns+` FROM nodes
		WHERE deleted=0 AND type=? AND id=(
			SELECT result_node_id FROM tasks WHERE node_id=? AND status='succeeded'
			AND result_node_id IN (SELECT id FROM nodes WHERE deleted=0)
			ORDER BY tasks.rowid DESC LIMIT 1
		)`, source.Type, source.ID))
	if errors.Is(err, sql.ErrNoRows) {
		return Node{}, nil
	}
	return result, err
}

type appendArgs struct {
	operation
	Nodes []NodeInput `json:"nodes"`
	Edges []Edge      `json:"edges"`
}

type appendResult struct {
	IDs      []string `json:"ids"`
	EventSeq int64    `json:"eventSeq"`
}

func (s *Service) append(ctx context.Context, p *project, r Request) (any, error) {
	var args appendArgs
	if err := decodeData(r.Data, &args); err != nil {
		return nil, err
	}
	human := r.Actor == "human"
	var affected []string
	if human {
		for _, edge := range args.Edges {
			if !slices.ContainsFunc(args.Nodes, func(node NodeInput) bool { return node.ID == edge.Target }) &&
				!slices.Contains(affected, edge.Target) {
				affected = append(affected, edge.Target)
			}
		}
	}
	return p.writeChecked(ctx, r, args.ID, func(tx *sql.Tx, _ Status) (any, error) {
		if len(args.Nodes)+len(args.Edges) == 0 {
			return nil, invalid("需要至少一个新节点或引用")
		}
		return appendNodes(ctx, tx, r.SessionID, args.Nodes, args.Edges, human)
	}, func(tx *sql.Tx) error {
		return s.checkCanvasMutation(ctx, tx, r, affected)
	})
}

func appendNodes(ctx context.Context, tx *sql.Tx, session string, nodes []NodeInput, edges []Edge, draft bool) (appendResult, error) {
	result := appendResult{IDs: make([]string, 0, len(nodes))}
	checkVideos := make(map[string]struct{})
	imageEdges := make(map[string][]string)
	videoEdges := make(map[string][]string)
	newNodes := make(map[string]bool, len(nodes))
	touchedTargets := make(map[string]bool)
	eventIDs := make([]string, 0, len(nodes)+len(edges)*2)
	createdAt := time.Now().UTC().Format(time.RFC3339Nano)
	for _, n := range nodes {
		if err := validateNode(n); err != nil {
			return appendResult{}, err
		}
		if n.ID == "" {
			n.ID = uuid.NewString()
		}
		if n.BasedOn == n.ID {
			return appendResult{}, invalid("新版本不能引用自己")
		}
		if n.BasedOn != "" {
			var exists bool
			if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM nodes WHERE id=?)", n.BasedOn).Scan(&exists); err != nil {
				return appendResult{}, err
			}
			if !exists {
				return appendResult{}, invalid("来源节点 %q 不存在于当前 Canvas", n.BasedOn)
			}
		}
		insert, err := tx.ExecContext(ctx, `INSERT INTO nodes(id,type,based_on,created_by,episode_id,scene_id,shot_id,content,created_at)
			VALUES(?,?,NULLIF(?,''),?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
			n.ID, n.Type, n.BasedOn, session, n.EpisodeID, n.SceneID, n.ShotID, string(n.Content), createdAt)
		if err != nil {
			return appendResult{}, err
		}
		if count, err := insert.RowsAffected(); err != nil {
			return appendResult{}, err
		} else if count == 0 {
			return appendResult{}, &requestError{http.StatusConflict, "节点 ID 已存在，请为新增节点使用新 ID"}
		}
		newNodes[n.ID] = true
		result.IDs = append(result.IDs, n.ID)
		eventIDs = append(eventIDs, n.ID)
		if n.Type == "video" {
			checkVideos[n.ID] = struct{}{}
		}
	}
	for _, edge := range edges {
		if edge.Source == edge.Target {
			return appendResult{}, invalid("节点不能引用自己")
		}
		source, err := nodeType(ctx, tx, edge.Source)
		if err != nil {
			return appendResult{}, err
		}
		target, err := nodeType(ctx, tx, edge.Target)
		if err != nil {
			return appendResult{}, err
		}
		if target == "video" {
			if !isVideoMedia(source) {
				return appendResult{}, invalid("视频节点只接受媒体输入")
			}
			checkVideos[edge.Target] = struct{}{}
			videoEdges[edge.Target] = append(videoEdges[edge.Target], edge.Source)
		}
		if target == "image" {
			if source != "image" && !isTextNode(source) {
				return appendResult{}, invalid("图片节点只接受图片和文本输入")
			}
			imageEdges[edge.Target] = append(imageEdges[edge.Target], edge.Source)
		}
		if _, err := tx.ExecContext(ctx, "INSERT INTO edges VALUES(?,?)", edge.Source, edge.Target); err != nil {
			return appendResult{}, err
		}
		if !newNodes[edge.Target] {
			touchedTargets[edge.Target] = true
		}
		eventIDs = append(eventIDs, edge.Source, edge.Target)
	}
	for target, sources := range imageEdges {
		if err := appendOrderedSources(ctx, tx, target, sources); err != nil {
			return appendResult{}, err
		}
	}
	if draft {
		for target, sources := range videoEdges {
			if err := appendOrderedSources(ctx, tx, target, sources); err != nil {
				return appendResult{}, err
			}
		}
	}
	for id := range checkVideos {
		if err := validateVideo(ctx, tx, id, draft); err != nil {
			return appendResult{}, err
		}
	}
	for id := range touchedTargets {
		if _, err := tx.ExecContext(ctx, "UPDATE nodes SET revision=revision+1 WHERE id=?", id); err != nil {
			return appendResult{}, err
		}
	}
	seq, err := addEvent(ctx, tx, "append", eventIDs)
	result.EventSeq = seq
	return result, err
}

func appendOrderedSources(ctx context.Context, tx *sql.Tx, id string, sources []string) error {
	var raw string
	if err := tx.QueryRowContext(ctx, "SELECT content FROM nodes WHERE id=?", id).Scan(&raw); err != nil {
		return err
	}
	var content map[string]json.RawMessage
	if err := json.Unmarshal([]byte(raw), &content); err != nil {
		return err
	}
	order := orderedSources(content)
	changed := false
	for _, source := range sources {
		if !slices.Contains(order, source) {
			order = append(order, source)
			changed = true
		}
	}
	if !changed {
		return nil
	}
	setOrderedSources(content, order)
	rawContent, err := json.Marshal(content)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, "UPDATE nodes SET content=? WHERE id=?", string(rawContent), id)
	return err
}

// Old projects may contain text links or links retained after source deletion.
// Rebuild media order from live connections without modifying the inline prompt.
func repairVideoReferences(ctx context.Context, tx *sql.Tx) error {
	rows, err := tx.QueryContext(ctx, `SELECT id,content FROM nodes WHERE type='video' AND deleted=0
		AND (json_type(content,'$.mixedListOrder') IS NOT NULL OR json_type(content,'$.textList') IS NOT NULL
		OR EXISTS(SELECT 1 FROM edges WHERE target=nodes.id))`)
	if err != nil {
		return err
	}
	type video struct{ id, raw string }
	var videos []video
	for rows.Next() {
		var item video
		if err := rows.Scan(&item.id, &item.raw); err != nil {
			rows.Close()
			return err
		}
		videos = append(videos, item)
	}
	if err := errors.Join(rows.Err(), rows.Close()); err != nil {
		return err
	}
	var repaired []string
	for _, item := range videos {
		var content map[string]json.RawMessage
		if err := json.Unmarshal([]byte(item.raw), &content); err != nil {
			return err
		}
		valid, err := relatedNodeIDs(ctx, tx, `SELECT source FROM edges JOIN nodes ON source=nodes.id
			WHERE target=? AND deleted=0 AND type IN ('image','video','audio') ORDER BY edges.rowid`, item.id)
		if err != nil {
			return err
		}
		remove, err := tx.ExecContext(ctx, `DELETE FROM edges WHERE target=? AND source IN
			(SELECT id FROM nodes WHERE deleted=1 OR type NOT IN ('image','video','audio'))`, item.id)
		if err != nil {
			return err
		}
		removed, err := remove.RowsAffected()
		if err != nil {
			return err
		}
		previous := orderedSources(content)
		var order []string
		for _, source := range append(slices.Clone(previous), valid...) {
			if slices.Contains(valid, source) && !slices.Contains(order, source) {
				order = append(order, source)
			}
		}
		var text []json.RawMessage
		if raw, exists := content["textList"]; exists && (json.Unmarshal(raw, &text) != nil || len(text) > 0) {
			delete(content, "textList")
			removed++
		}
		if removed == 0 && slices.Equal(previous, order) {
			continue
		}
		setOrderedSources(content, order)
		data, err := json.Marshal(content)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, "UPDATE nodes SET content=?,revision=revision+1 WHERE id=?", string(data), item.id); err != nil {
			return err
		}
		repaired = append(repaired, item.id)
	}
	if len(repaired) > 0 {
		_, err = addEvent(ctx, tx, "update", repaired)
	}
	return err
}

func isTextNode(kind string) bool {
	return kind == "script" || kind == "shot" || kind == "prompt" || kind == "note"
}

func nodeType(ctx context.Context, tx *sql.Tx, id string) (string, error) {
	var kind string
	err := tx.QueryRowContext(ctx, "SELECT type FROM nodes WHERE id=? AND deleted=0", id).Scan(&kind)
	if errors.Is(err, sql.ErrNoRows) {
		return "", invalid("引用节点 %q 不存在于当前 Canvas", id)
	}
	return kind, err
}

func validateNode(n NodeInput) error {
	switch n.Type {
	case "script", "shot", "prompt", "image", "video", "audio", "note":
	default:
		return invalid("不支持的节点类型 %q", n.Type)
	}
	if n.ID != "" {
		if id, err := uuid.Parse(n.ID); err != nil || id.String() != n.ID {
			return invalid("节点 ID 必须是 UUID")
		}
	}
	var content map[string]json.RawMessage
	if err := json.Unmarshal(n.Content, &content); err != nil || content == nil {
		return invalid("节点 content 必须是 JSON 对象")
	}
	if !isVideoMedia(n.Type) {
		return nil
	}
	if len(n.Content) > 64<<10 {
		return invalid("媒体节点只能保存元数据和引用")
	}
	if raw, ok := content["url"]; ok {
		var value string
		if json.Unmarshal(raw, &value) != nil {
			return invalid("媒体 URL 必须是字符串")
		}
		parsed, err := url.Parse(value)
		if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.Hostname() == "" || parsed.User != nil {
			return invalid("媒体 URL 必须是有效的 HTTP/HTTPS 地址")
		}
	}
	var assetPath string
	if raw, ok := content["path"]; ok {
		prefix := map[string]string{"image": "assets/images/", "video": "assets/", "audio": "assets/audio/"}[n.Type]
		if json.Unmarshal(raw, &assetPath) != nil || !filepath.IsLocal(assetPath) || strings.ContainsAny(assetPath, "\\:") ||
			!strings.HasPrefix(assetPath, prefix) || path.Clean(assetPath) != assetPath || len(assetPath) == len(prefix) {
			return invalid("媒体文件必须使用 %s 下的相对路径", prefix)
		}
	}
	if raw, ok := content["assetId"]; ok {
		var assetID string
		if err := json.Unmarshal(raw, &assetID); err != nil || !importedAssetID.MatchString(assetID) {
			return invalid("assetId 必须是导入素材的文件标识")
		}
		directory := map[string]string{"image": "assets/images", "video": "assets/videos", "audio": "assets/audio"}[n.Type]
		if assetPath != directory+"/"+assetID {
			return invalid("assetId 必须与素材路径对应")
		}
	}
	if raw, ok := content["canvasPosition"]; ok {
		var position struct {
			X *float64 `json:"x"`
			Y *float64 `json:"y"`
		}
		if err := json.Unmarshal(raw, &position); err != nil || position.X == nil || position.Y == nil {
			return invalid("canvasPosition 必须包含有效的 x 和 y 坐标")
		}
	}
	return nil
}

var importedAssetID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[A-Za-z0-9]+$`)

var mediaReference = regexp.MustCompile(`(?i)@(图片|视频|音频|文本|脚本|提示词|说明|image|video|audio|text|script|prompt|note)[ \t]*([0-9]+)|<<<(image|video|audio|text|script|prompt|note)_([0-9]+)>>>`)

func isVideoMedia(kind string) bool {
	return kind == "image" || kind == "video" || kind == "audio"
}

func validateVideoInputs(mode string, kinds []string) error {
	switch mode {
	case "t2v":
		if len(kinds) != 0 {
			return invalid("T2V 只接受完整提示词")
		}
	case "i2v":
		if len(kinds) == 0 || len(kinds) > 2 || kinds[0] != "image" || len(kinds) == 2 && kinds[1] != "image" {
			return invalid("I2V 需要首帧图片，可选一张尾帧图片")
		}
	case "r2v":
		if len(kinds) == 0 {
			return invalid("R2V 需要至少一个参考媒体")
		}
		for _, kind := range kinds {
			if !isVideoMedia(kind) {
				return invalid("R2V 只接受图片、视频或音频素材")
			}
		}
	case "v2v":
		if len(kinds) != 1 || kinds[0] != "video" {
			return invalid("V2V 需要一个源视频")
		}
	default:
		return invalid("未知视频生成方式")
	}
	return nil
}

func validateVideoDraftMode(mode string, kinds []string, draft bool) error {
	if draft && len(kinds) == 0 && (mode == "i2v" || mode == "r2v" || mode == "v2v") {
		return nil
	}
	return validateVideoInputs(mode, kinds)
}

func validateVideoDraftFields(raw string) error {
	var content map[string]json.RawMessage
	if err := json.Unmarshal([]byte(raw), &content); err != nil {
		return invalid("视频生成节点格式无效")
	}
	for field := range content {
		switch strings.ReplaceAll(strings.ReplaceAll(strings.ToLower(field), "_", ""), "-", "") {
		case "apikey", "apitoken", "authorization", "credentials", "baseurl", "apiurl", "protocol", "headers",
			"authheader", "auth", "requestmapping", "taskplugin", "advanced", "submiturl", "queryurl":
			return invalid("视频生成节点须从 Drama Studio 全局设置读取渠道配置")
		}
	}
	return nil
}

func decodeVideoParams(raw json.RawMessage) (VideoParams, error) {
	var params VideoParams
	if err := decodeData(raw, &params); err != nil {
		return VideoParams{}, invalid("视频节点参数仅支持时长、分辨率、画幅和生成音频")
	}
	return params, validateVideoParams(params)
}

func validateVideo(ctx context.Context, tx *sql.Tx, id string, draft bool) error {
	var raw string
	if err := tx.QueryRowContext(ctx, "SELECT content FROM nodes WHERE id=?", id).Scan(&raw); err != nil {
		return err
	}
	var data struct {
		Prompt         string            `json:"prompt"`
		Mode           string            `json:"mode"`
		ProfileID      json.RawMessage   `json:"profileId"`
		Path           string            `json:"path"`
		URL            string            `json:"url"`
		TextList       []json.RawMessage `json:"textList"`
		MixedListOrder []string          `json:"mixedListOrder"`
		Params         json.RawMessage   `json:"params"`
	}
	if err := json.Unmarshal([]byte(raw), &data); err != nil {
		return invalid("视频提示词或媒体引用格式无效：%s", err)
	}
	if len(data.TextList) != 0 {
		return invalid("视频节点 textList 必须为空")
	}
	rows, err := tx.QueryContext(ctx, "SELECT source,type,content FROM edges JOIN nodes ON nodes.id=source WHERE target=? ORDER BY edges.rowid", id)
	if err != nil {
		return err
	}
	defer rows.Close()
	media := make(map[string]string)
	counts := make(map[string]int)
	for rows.Next() {
		var source, kind, rawContent string
		if err := rows.Scan(&source, &kind, &rawContent); err != nil {
			return err
		}
		if !isVideoMedia(kind) {
			return invalid("视频节点只接受媒体输入")
		}
		var ref struct {
			Path string `json:"path"`
			URL  string `json:"url"`
		}
		if err := json.Unmarshal([]byte(rawContent), &ref); err != nil || !draft && (ref.Path == "" && ref.URL == "") {
			return invalid("视频输入必须引用已保存的媒体 URL 或相对文件")
		}
		media[source] = kind
		counts[kind]++
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if data.Mode == "asset" {
		if len(media) != 0 || len(data.MixedListOrder) != 0 {
			return invalid("视频素材节点不能接入生成参考")
		}
		if strings.TrimSpace(data.Prompt) != "" ||
			len(data.ProfileID) != 0 && string(data.ProfileID) != "null" && string(data.ProfileID) != `""` ||
			len(data.Params) != 0 && string(data.Params) != "null" {
			return invalid("视频素材节点不能保存生成提示词、模型或参数")
		}
		return validateVideoDraftFields(raw)
	}
	isDraft := data.Path == "" && data.URL == "" || data.Mode != "" || len(media) > 0
	if isDraft {
		if !draft && strings.TrimSpace(data.Prompt) == "" {
			return invalid("视频生成节点必须在 content.prompt 内联完整提示词")
		}
		if err := validateVideoDraftFields(raw); err != nil {
			return err
		}
		if _, err := decodeVideoParams(data.Params); err != nil {
			return err
		}
	}
	if len(data.MixedListOrder) != len(media) {
		return invalid("mixedListOrder 必须与已连接的媒体一一对应")
	}
	kinds := make([]string, 0, len(media))
	for _, source := range data.MixedListOrder {
		kind, ok := media[source]
		if !ok {
			return invalid("mixedListOrder 只能引用已连接媒体且不得重复")
		}
		kinds = append(kinds, kind)
		delete(media, source)
	}
	if data.Mode != "" {
		if err := validateVideoDraftMode(data.Mode, kinds, draft); err != nil {
			return err
		}
	}
	return checkVideoPromptReferences(data.Prompt, counts, draft)
}

func validateVideoPromptReferences(prompt string, kinds []string) error {
	counts := make(map[string]int)
	for _, kind := range kinds {
		counts[kind]++
	}
	return checkVideoPromptReferences(prompt, counts, false)
}

func checkVideoPromptReferences(prompt string, counts map[string]int, draft bool) error {
	for _, ref := range mediaReference.FindAllStringSubmatch(prompt, -1) {
		kind, number := ref[1], ref[2]
		if kind == "" {
			kind, number = ref[3], ref[4]
		}
		kind = strings.ToLower(kind)
		switch kind {
		case "图片":
			kind = "image"
		case "视频":
			kind = "video"
		case "音频":
			kind = "audio"
		}
		index, err := strconv.Atoi(number)
		if err != nil || index < 1 || index > counts[kind] && (!draft || !isVideoMedia(kind)) {
			return invalid("提示词引用 %s 没有对应的已连接媒体", ref[0])
		}
	}
	return nil
}
