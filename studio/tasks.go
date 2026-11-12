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

func (p *project) submit(ctx context.Context, r Request, providers providerRegistry) (any, error) {
	var args submitArgs
	if r.Action == "submit_manual" {
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
			Mode: input.Mode, Provider: input.Profile.Provider, Model: input.Profile.Model}
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
	}
	if (kind != "image" && kind != "video") || json.Unmarshal([]byte(snapshot), &content) != nil || strings.TrimSpace(content.Prompt) == "" {
		return "", "", invalid("选择内联完整提示词的图片或视频节点")
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
	Mode             string `json:"mode,omitempty"`
	Provider         string `json:"provider,omitempty"`
	Model            string `json:"model,omitempty"`
}

const taskColumns = "id,node_id,session_id,type,status,provider_id,result_node_id,error,created_at,updated_at,input"

func scanTask(row interface{ Scan(...any) error }) (Task, string, error) {
	var task Task
	var input string
	err := row.Scan(&task.ID, &task.NodeID, &task.CreatedBySession, &task.Type, &task.Status,
		&task.ProviderTaskID, &task.ResultNodeID, &task.Error, &task.CreatedAt, &task.UpdatedAt, &input)
	if err == nil {
		var request GenerationInput
		if json.Unmarshal([]byte(input), &request) == nil {
			task.Mode, task.Provider, task.Model = request.Mode, request.Profile.Provider, request.Profile.Model
		}
	}
	return task, input, err
}

func generationInput(ctx context.Context, tx *sql.Tx, id, kind, snapshot string) (GenerationInput, string, error) {
	var content struct {
		Prompt    string   `json:"prompt"`
		Order     []string `json:"mixedListOrder"`
		Mode      string   `json:"mode"`
		ProfileID string   `json:"profileId"`
	}
	if err := json.Unmarshal([]byte(snapshot), &content); err != nil {
		return GenerationInput{}, "", invalid("生成节点的媒体引用无效")
	}
	input := GenerationInput{Type: kind, Prompt: content.Prompt, Mode: content.Mode}
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
		if refType != "image" {
			return GenerationInput{}, "", invalid("当前仅支持图片输入，视频到视频暂不可用")
		}
		if json.Unmarshal([]byte(raw), &media) != nil || (!providerURL(media.URL) && media.Path == "") {
			return GenerationInput{}, "", invalid("模型参考素材需要项目内图片或可访问的外部 HTTP/HTTPS URL")
		}
		ref := GenerationReference{Type: "image", Path: media.Path}
		if providerURL(media.URL) {
			ref.URL = media.URL
		}
		input.References = append(input.References, ref)
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
		switch count {
		case 0:
			input.Mode = "t2v"
		case 1:
			input.Mode = "i2v"
		default:
			input.Mode = "r2v"
		}
	}
	if !validVideoMode(input.Mode, count) {
		return GenerationInput{}, "", invalid("T2V 使用完整提示词，I2V 需要一张首帧，R2V 需要至少一张参考图片")
	}
	return input, content.ProfileID, nil
}

func validVideoMode(mode string, count int) bool {
	return mode == "t2v" && count == 0 || mode == "i2v" && count == 1 || mode == "r2v" && count > 0
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
