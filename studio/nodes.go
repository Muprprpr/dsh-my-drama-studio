package studio

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/url"
	"path"
	"path/filepath"
	"regexp"
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
	Offset           int    `json:"offset"`
	Limit            int    `json:"limit"`
}

type queryResult struct {
	Nodes   []Node `json:"nodes"`
	Edges   []Edge `json:"edges"`
	Status  Status `json:"status"`
	HasMore bool   `json:"hasMore"`
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
	query := `SELECT id,type,COALESCE(based_on,''),episode_id,scene_id,shot_id,content,created_by,created_at FROM nodes WHERE 1=1`
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
		var n Node
		var content string
		err := rows.Scan(&n.ID, &n.Type, &n.BasedOn, &n.EpisodeID, &n.SceneID, &n.ShotID, &content, &n.CreatedBySession, &n.CreatedAt)
		if err != nil {
			return queryResult{}, err
		}
		n.Content = json.RawMessage(content)
		result.Nodes = append(result.Nodes, n)
		ids = append(ids, n.ID)
	}
	if err := rows.Close(); err != nil {
		return queryResult{}, err
	}
	if err := rows.Err(); err != nil || len(ids) == 0 {
		return result, err
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")
	rows, err = tx.QueryContext(ctx, "SELECT source,target FROM edges WHERE source IN ("+placeholders+") AND target IN ("+placeholders+") ORDER BY rowid", append(ids, ids...)...)
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
	return result, rows.Err()
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

func (p *project) append(ctx context.Context, r Request) (any, error) {
	var args appendArgs
	if err := decodeData(r.Data, &args); err != nil {
		return nil, err
	}
	return p.write(ctx, r, args.ID, func(tx *sql.Tx, _ Status) (any, error) {
		if len(args.Nodes)+len(args.Edges) == 0 {
			return nil, invalid("需要至少一个新节点或引用")
		}
		return appendNodes(ctx, tx, r.SessionID, args.Nodes, args.Edges)
	})
}

func appendNodes(ctx context.Context, tx *sql.Tx, session string, nodes []NodeInput, edges []Edge) (appendResult, error) {
	result := appendResult{IDs: make([]string, 0, len(nodes))}
	checkVideos := make(map[string]struct{})
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
			if _, err := nodeType(ctx, tx, n.BasedOn); err != nil {
				return appendResult{}, err
			}
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO nodes VALUES(?,?,NULLIF(?,''),?,?,?,?,?,?)`,
			n.ID, n.Type, n.BasedOn, session, n.EpisodeID, n.SceneID, n.ShotID, string(n.Content), createdAt); err != nil {
			return appendResult{}, err
		}
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
		}
		if _, err := tx.ExecContext(ctx, "INSERT INTO edges VALUES(?,?)", edge.Source, edge.Target); err != nil {
			return appendResult{}, err
		}
		eventIDs = append(eventIDs, edge.Source, edge.Target)
	}
	for id := range checkVideos {
		if err := validateVideo(ctx, tx, id); err != nil {
			return appendResult{}, err
		}
	}
	seq, err := addEvent(ctx, tx, "append", eventIDs)
	result.EventSeq = seq
	return result, err
}

func nodeType(ctx context.Context, tx *sql.Tx, id string) (string, error) {
	var kind string
	err := tx.QueryRowContext(ctx, "SELECT type FROM nodes WHERE id=?", id).Scan(&kind)
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
	if raw, ok := content["path"]; ok {
		var value string
		prefix := map[string]string{"image": "assets/images/", "video": "assets/", "audio": "assets/audio/"}[n.Type]
		if json.Unmarshal(raw, &value) != nil || !filepath.IsLocal(value) || strings.ContainsAny(value, "\\:") ||
			!strings.HasPrefix(value, prefix) || path.Clean(value) != value || len(value) == len(prefix) {
			return invalid("媒体文件必须使用 %s 下的相对路径", prefix)
		}
	}
	return nil
}

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

func validateVideo(ctx context.Context, tx *sql.Tx, id string) error {
	var raw string
	if err := tx.QueryRowContext(ctx, "SELECT content FROM nodes WHERE id=?", id).Scan(&raw); err != nil {
		return err
	}
	var data struct {
		Prompt         string            `json:"prompt"`
		Mode           string            `json:"mode"`
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
		if err := json.Unmarshal([]byte(rawContent), &ref); err != nil || (ref.Path == "" && ref.URL == "") {
			return invalid("视频输入必须引用已保存的媒体 URL 或相对文件")
		}
		media[source] = kind
		counts[kind]++
	}
	if err := rows.Err(); err != nil {
		return err
	}
	isDraft := data.Path == "" && data.URL == "" || data.Mode != "" || len(media) > 0
	if isDraft {
		if strings.TrimSpace(data.Prompt) == "" {
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
		if err := validateVideoInputs(data.Mode, kinds); err != nil {
			return err
		}
	}
	for _, ref := range mediaReference.FindAllStringSubmatch(data.Prompt, -1) {
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
		if err != nil || index < 1 || index > counts[kind] {
			return invalid("提示词引用 %s 没有对应的已连接媒体", ref[0])
		}
	}
	return nil
}
