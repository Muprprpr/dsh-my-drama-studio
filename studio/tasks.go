package studio

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
)

var automaticDisabled = &requestError{http.StatusForbidden, "Automatic generation is disabled"}
var providerUnavailable = &requestError{http.StatusServiceUnavailable, "No verified generation provider is configured"}

type mutationResult struct {
	EventSeq int64 `json:"eventSeq"`
}

func (p *project) permission(ctx context.Context, r Request) (any, error) {
	var args struct {
		operation
		Enabled *bool `json:"enabled"`
	}
	if err := decodeData(r.Data, &args); err != nil {
		return nil, err
	}
	if args.Enabled == nil {
		return nil, invalid("需要明确选择是否启用自动生成")
	}
	return p.write(ctx, r, args.ID, func(tx *sql.Tx, status Status) (any, error) {
		if status.AutoGenerate == *args.Enabled {
			return mutationResult{EventSeq: status.EventSeq}, nil
		}
		statement := "DELETE FROM temp.session_permission WHERE session_id=?"
		if *args.Enabled {
			statement = "INSERT INTO temp.session_permission VALUES(?)"
		}
		if _, err := tx.ExecContext(ctx, statement, r.SessionID); err != nil {
			return nil, err
		}
		seq, err := addEvent(ctx, tx, "permission", []string{r.SessionID})
		return mutationResult{EventSeq: seq}, err
	})
}

type submitArgs struct {
	operation
	NodeID    string `json:"nodeId"`
	ProfileID string `json:"profileId,omitempty"`
}

func (p *project) submit(ctx context.Context, r Request, providers providerRegistry, expectedMode string) (any, error) {
	var args submitArgs
	if r.Action != "submit" {
		var manual struct {
			submitArgs
			Confirmed bool `json:"confirmed"`
		}
		if err := decodeData(r.Data, &manual); err != nil {
			return nil, err
		}
		if !manual.Confirmed {
			return nil, invalid("手动生成需要明确确认")
		}
		args = manual.submitArgs
	} else if err := decodeData(r.Data, &args); err != nil {
		return nil, err
	}
	return p.write(ctx, r, args.ID, func(tx *sql.Tx, status Status) (any, error) {
		if r.Action == "submit" && !status.AutoGenerate {
			return nil, automaticDisabled
		}
		kind, snapshot, err := submissionNode(ctx, tx, args.NodeID)
		if err != nil {
			return nil, err
		}
		if kind == "video" {
			if err := validateVideo(ctx, tx, args.NodeID); err != nil {
				return nil, err
			}
		}
		if providers == nil {
			return nil, providerUnavailable
		}
		input, pinned, err := generationInput(ctx, tx, args.NodeID, kind, snapshot)
		if err != nil {
			return nil, err
		}
		if expectedMode != "" && (input.Type != "video" || input.Mode != expectedMode) {
			return nil, invalid("当前视频节点的生成方式与请求不匹配")
		}
		if args.ProfileID == "" {
			args.ProfileID = pinned
		}
		if err := providers.Prepare(&input, args.ProfileID); err != nil {
			return nil, err
		}
		encoded, err := json.Marshal(input)
		if err != nil {
			return nil, err
		}
		now := time.Now().UTC().Format(time.RFC3339Nano)
		task := Task{ID: uuid.NewString(), NodeID: args.NodeID, CreatedBySession: r.SessionID, Type: kind,
			Status: "pending", CreatedAt: now, UpdatedAt: now,
			Mode: input.Mode, Provider: input.Profile.Provider, Model: input.Profile.Model, ChannelID: input.Profile.ChannelID}
		_, err = tx.ExecContext(ctx, `INSERT INTO tasks(id,node_id,session_id,type,status,input,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?,?)`, task.ID, task.NodeID, task.CreatedBySession, task.Type, task.Status, string(encoded), now, now)
		if err != nil {
			return nil, err
		}
		seq, err := addEvent(ctx, tx, "task", []string{task.ID})
		return struct {
			Task     Task  `json:"task"`
			EventSeq int64 `json:"eventSeq"`
		}{task, seq}, err
	})
}

func submissionNode(ctx context.Context, tx *sql.Tx, id string) (kind, snapshot string, err error) {
	err = tx.QueryRowContext(ctx, "SELECT type,content FROM nodes WHERE id=?", id).Scan(&kind, &snapshot)
	if errors.Is(err, sql.ErrNoRows) {
		return "", "", invalid("待生成节点不存在于当前 Canvas")
	}
	if err != nil {
		return "", "", err
	}
	var content struct {
		Prompt string `json:"prompt"`
		Mode   string `json:"mode"`
		Path   string `json:"path"`
		URL    string `json:"url"`
	}
	if (kind != "image" && kind != "video") || json.Unmarshal([]byte(snapshot), &content) != nil || strings.TrimSpace(content.Prompt) == "" {
		return "", "", invalid("选择内联完整提示词的图片或视频节点")
	}
	if kind == "video" && content.Mode == "" && (content.Path != "" || content.URL != "") {
		return "", "", invalid("请选择视频生成草稿")
	}
	return kind, snapshot, nil
}

func (p *project) tasks(ctx context.Context, r Request) (any, error) {
	if err := decodeData(r.Data, &struct{}{}); err != nil {
		return nil, err
	}
	tx, err := p.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	status, err := getStatus(ctx, tx, r)
	if err != nil {
		return nil, err
	}
	if !status.Connected {
		return nil, notBound
	}
	rows, err := tx.QueryContext(ctx, "SELECT "+taskColumns+" FROM tasks ORDER BY rowid DESC LIMIT 100")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	tasks := make([]Task, 0)
	for rows.Next() {
		task, _, err := scanTask(rows)
		if err != nil {
			return nil, err
		}
		tasks = append(tasks, task)
	}
	return map[string][]Task{"tasks": tasks}, rows.Err()
}

type Task struct {
	ID               string `json:"id"`
	NodeID           string `json:"nodeId"`
	CreatedBySession string `json:"createdBySession"`
	Type             string `json:"type"`
	Status           string `json:"status"`
	ProviderTaskID   string `json:"providerTaskId,omitempty"`
	ResultNodeID     string `json:"resultNodeId,omitempty"`
	Error            string `json:"error,omitempty"`
	CreatedAt        string `json:"createdAt"`
	UpdatedAt        string `json:"updatedAt"`
	CompletedAt      string `json:"completedAt,omitempty"`
	OutputPath       string `json:"outputPath,omitempty"`
	Mode             string `json:"mode,omitempty"`
	Provider         string `json:"provider,omitempty"`
	Model            string `json:"model,omitempty"`
	ChannelID        string `json:"channelId,omitempty"`
	outputDirectory  string
}

func (task Task) MarshalJSON() ([]byte, error) {
	status, phase := task.Status, ""
	switch task.Status {
	case "pending":
		status = "queued"
	case "submitting", "polling", "paused":
		status, phase = "processing", task.Status
	case "succeeded":
		status = "completed"
	case "uncertain":
		status, phase = "failed", "submission_unknown"
	}
	type fields Task
	return json.Marshal(struct {
		fields
		Status string `json:"status"`
		Phase  string `json:"phase,omitempty"`
	}{fields(task), status, phase})
}

const taskColumns = "id,node_id,session_id,type,status,provider_id,result_node_id,error,created_at,updated_at,completed_at,output_path,input"

func scanTask(row interface{ Scan(...any) error }) (Task, string, error) {
	var task Task
	var input string
	err := row.Scan(&task.ID, &task.NodeID, &task.CreatedBySession, &task.Type, &task.Status,
		&task.ProviderTaskID, &task.ResultNodeID, &task.Error, &task.CreatedAt, &task.UpdatedAt, &task.CompletedAt, &task.OutputPath, &input)
	if err == nil {
		var request GenerationInput
		if json.Unmarshal([]byte(input), &request) == nil {
			task.Mode, task.Provider, task.Model = request.Mode, request.Profile.Provider, request.Profile.Model
			task.ChannelID = request.Profile.ChannelID
		}
	}
	return task, input, err
}

func migrateTaskFields(ctx context.Context, tx *sql.Tx) error {
	rows, err := tx.QueryContext(ctx, "SELECT name FROM pragma_table_info('tasks')")
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
	if !columns["completed_at"] {
		if _, err := tx.ExecContext(ctx, `ALTER TABLE tasks ADD COLUMN completed_at TEXT NOT NULL DEFAULT '';
			UPDATE tasks SET completed_at=updated_at WHERE status IN ('succeeded','failed','cancelled','uncertain')`); err != nil {
			return err
		}
	}
	if !columns["output_path"] {
		if _, err := tx.ExecContext(ctx, `ALTER TABLE tasks ADD COLUMN output_path TEXT NOT NULL DEFAULT '';
			UPDATE tasks SET output_path=COALESCE((SELECT json_extract(content,'$.path') FROM nodes WHERE id=tasks.result_node_id),'')
			WHERE result_node_id<>''`); err != nil {
			return err
		}
	}
	return nil
}

func (p *project) controlTask(ctx context.Context, r Request) (any, error) {
	var args struct {
		operation
		TaskID string `json:"taskId"`
	}
	if err := decodeData(r.Data, &args); err != nil {
		return nil, err
	}
	return p.write(ctx, r, args.ID, func(tx *sql.Tx, _ Status) (any, error) {
		task, _, err := scanTask(tx.QueryRowContext(ctx, "SELECT "+taskColumns+" FROM tasks WHERE id=?", args.TaskID))
		if errors.Is(err, sql.ErrNoRows) {
			return nil, invalid("任务不存在")
		}
		if err != nil {
			return nil, err
		}
		next := "cancelled"
		if r.Action == "resume_task" {
			if task.Status != "paused" || task.ProviderTaskID == "" {
				return nil, invalid("只有已暂停且有上游 ID 的任务可以继续查询")
			}
			next = "polling"
		} else if task.Status != "pending" {
			return nil, invalid("只有尚未提交的任务可以从队列取消")
		}
		if err := updateTask(ctx, tx, task, next, task.ProviderTaskID, "", "", ""); err != nil {
			return nil, err
		}
		seq, err := addEvent(ctx, tx, "task", []string{task.ID})
		return mutationResult{EventSeq: seq}, err
	})
}

func generationInput(ctx context.Context, tx *sql.Tx, id, kind, snapshot string) (GenerationInput, string, error) {
	var content struct {
		Prompt    string          `json:"prompt"`
		Order     []string        `json:"mixedListOrder"`
		Mode      string          `json:"mode"`
		ProfileID string          `json:"profileId"`
		Params    json.RawMessage `json:"params"`
	}
	if err := json.Unmarshal([]byte(snapshot), &content); err != nil {
		return GenerationInput{}, "", invalid("生成节点的媒体引用无效")
	}
	input := GenerationInput{Type: kind, Prompt: content.Prompt, Mode: content.Mode}
	if kind == "video" {
		params, err := decodeVideoParams(content.Params)
		if err != nil {
			return GenerationInput{}, "", err
		}
		input.Params = params
	}
	kinds := make([]string, 0, len(content.Order))
	for _, reference := range content.Order {
		var raw, refType string
		err := tx.QueryRowContext(ctx, `SELECT type,content FROM nodes JOIN edges ON edges.source=nodes.id
  WHERE edges.target=? AND nodes.id=?`, id, reference).Scan(&refType, &raw)
		if errors.Is(err, sql.ErrNoRows) {
			return GenerationInput{}, "", invalid("生成节点引用了未连接媒体")
		}
		if err != nil {
			return GenerationInput{}, "", err
		}
		var media struct {
			URL  string `json:"url"`
			Path string `json:"path"`
		}
		if refType != "image" && (kind != "video" || refType != "video" && refType != "audio") {
			return GenerationInput{}, "", invalid("生成节点只能读取实际连接的媒体")
		}
		if json.Unmarshal([]byte(raw), &media) != nil || (!providerURL(media.URL) && media.Path == "") {
			return GenerationInput{}, "", invalid("模型参考素材需要项目内媒体或可访问的外部 HTTP/HTTPS URL")
		}
		ref := GenerationReference{Type: refType, Path: media.Path}
		if providerURL(media.URL) {
			ref.URL = media.URL
		}
		input.References = append(input.References, ref)
		kinds = append(kinds, refType)
	}
	if kind == "image" {
		if input.Mode != "" && input.Mode != "t2i" {
			return GenerationInput{}, "", invalid("图片节点需要 T2I 预设")
		}
		input.Mode = "t2i"
		return input, content.ProfileID, nil
	}
	count := len(input.References)
	if input.Mode == "" {
		for _, media := range kinds {
			if media != "image" {
				return GenerationInput{}, "", invalid("包含视频或音频素材的节点需要明确生成方式")
			}
		}
		switch count {
		case 0:
			input.Mode = "t2v"
		case 1:
			input.Mode = "i2v"
		default:
			input.Mode = "r2v"
		}
	}
	if err := validateVideoInputs(input.Mode, kinds); err != nil {
		return GenerationInput{}, "", err
	}
	return input, content.ProfileID, nil
}

func providerURL(value string) bool {
	parsed, err := url.Parse(value)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.User != nil {
		return false
	}
	host := strings.TrimRight(strings.ToLower(parsed.Hostname()), ".")
	if host == "" || host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return false
	}
	if ip, err := netip.ParseAddr(host); err == nil {
		ip = ip.Unmap()
		return ip.IsGlobalUnicast() && !ip.IsPrivate()
	}
	separator := strings.LastIndexByte(host, '.')
	if separator < 1 || strings.HasPrefix(host, "127.") {
		return false
	}
	last := host[separator+1:]
	return !strings.HasPrefix(last, "0x") && strings.IndexFunc(last, func(r rune) bool { return r < '0' || r > '9' }) >= 0
}
