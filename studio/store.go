package studio

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	_ "modernc.org/sqlite"
)

const schema = `
CREATE TABLE IF NOT EXISTS canvas_meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS session_bindings (session_id TEXT PRIMARY KEY, connected INTEGER NOT NULL);
CREATE TEMP TABLE IF NOT EXISTS session_permission (session_id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, based_on TEXT REFERENCES nodes(id),
  created_by TEXT NOT NULL, episode_id TEXT NOT NULL, scene_id TEXT NOT NULL,
  shot_id TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS edges (
  source TEXT NOT NULL REFERENCES nodes(id), target TEXT NOT NULL REFERENCES nodes(id),
  PRIMARY KEY(source,target)
);
CREATE INDEX IF NOT EXISTS edges_target ON edges(target);
CREATE INDEX IF NOT EXISTS nodes_shot ON nodes(episode_id,scene_id,shot_id);
CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, action TEXT NOT NULL, result TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, type TEXT NOT NULL, ids TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, node_id TEXT NOT NULL REFERENCES nodes(id), session_id TEXT NOT NULL,
  type TEXT NOT NULL, status TEXT NOT NULL, input TEXT NOT NULL,
  provider_id TEXT NOT NULL DEFAULT '', result_node_id TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS nodes_no_update BEFORE UPDATE ON nodes BEGIN SELECT RAISE(ABORT, 'nodes are append-only'); END;
CREATE TRIGGER IF NOT EXISTS nodes_no_delete BEFORE DELETE ON nodes BEGIN SELECT RAISE(ABORT, 'nodes are append-only'); END;
CREATE TRIGGER IF NOT EXISTS edges_no_update BEFORE UPDATE ON edges BEGIN SELECT RAISE(ABORT, 'edges are append-only'); END;
CREATE TRIGGER IF NOT EXISTS edges_no_delete BEFORE DELETE ON edges BEGIN SELECT RAISE(ABORT, 'edges are append-only'); END;
`

type Status struct {
	SessionID         string `json:"sessionId"`
	WorkspaceID       string `json:"workspaceId"`
	CanvasID          string `json:"canvasId"`
	Connected         bool   `json:"connected"`
	AutoGenerate      bool   `json:"autoGenerate"`
	ConnectedSessions int    `json:"connectedSessions"`
	EventSeq          int64  `json:"eventSeq"`
}

type Service struct {
	mu       sync.Mutex
	projects map[string]*project
	provider providerRegistry
	wake     chan struct{}
}

type project struct {
	db      *sql.DB
	dir     string
	mu      sync.Mutex
	changed chan struct{}
}

func New(provider providerRegistry) *Service {
	return &Service{projects: make(map[string]*project), provider: provider, wake: make(chan struct{}, 1)}
}

func (s *Service) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	var result error
	for _, p := range s.projects {
		result = errors.Join(result, p.db.Close())
	}
	return result
}

func (s *Service) open(ctx context.Context, directory string, create bool) (*project, error) {
	if !filepath.IsAbs(directory) {
		return nil, invalid("Workspace 必须是绝对目录")
	}
	dir, err := canonicalWorkspace(filepath.Clean(directory))
	if err != nil {
		return nil, invalid("Workspace 目录不可访问：%s", err)
	}
	info, err := os.Stat(dir)
	if err != nil || !info.IsDir() {
		return nil, invalid("Workspace 路径必须是目录")
	}
	key := dir
	if runtime.GOOS == "windows" {
		key = strings.ToLower(key)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if p := s.projects[key]; p != nil {
		return p, nil
	}
	dataDir := filepath.Join(dir, ".drama-studio")
	if create {
		if err := os.Mkdir(dataDir, 0o700); err != nil && !errors.Is(err, os.ErrExist) {
			return nil, err
		}
	}
	info, err = os.Lstat(dataDir)
	if !create && errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, invalid(".drama-studio 必须是 Workspace 内的普通目录")
	}
	file := filepath.Join(dataDir, "studio.db")
	info, err = os.Lstat(file)
	if !create && errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if info != nil && !info.Mode().IsRegular() {
		return nil, invalid("studio.db 必须是普通文件")
	}
	dbPath := filepath.ToSlash(file)
	if filepath.VolumeName(file) != "" && !strings.HasPrefix(dbPath, "/") {
		dbPath = "/" + dbPath
	}
	params := url.Values{"_pragma": {"busy_timeout(5000)", "foreign_keys(1)", "journal_mode(WAL)"}, "_txlock": {"immediate"}}
	if !create {
		params.Set("mode", "rw")
	}
	dsn := url.URL{Scheme: "file", Path: dbPath, RawQuery: params.Encode()}
	db, err := sql.Open("sqlite", dsn.String())
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		db.Close()
		return nil, err
	}
	_, err = tx.ExecContext(ctx, schema)
	if err == nil {
		_, err = tx.ExecContext(ctx, `INSERT INTO canvas_meta VALUES(1,?) ON CONFLICT DO NOTHING`, uuid.NewString())
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		tx.Rollback()
		db.Close()
		return nil, err
	}
	p := &project{db: db, dir: dir, changed: make(chan struct{})}
	s.projects[key] = p
	return p, nil
}

type rowQuery interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func getStatus(ctx context.Context, db rowQuery, r Request) (Status, error) {
	status := Status{SessionID: r.SessionID, WorkspaceID: r.WorkspaceID}
	if db == nil {
		return status, nil
	}
	err := db.QueryRowContext(ctx, `SELECT id,
  COALESCE((SELECT connected FROM session_bindings WHERE session_id=?), 0),
  EXISTS(SELECT 1 FROM temp.session_permission WHERE session_id=?),
  (SELECT COUNT(*) FROM session_bindings WHERE connected=1),
  COALESCE((SELECT MAX(seq) FROM events), 0)
	FROM canvas_meta WHERE singleton=1`, r.SessionID, r.SessionID).
		Scan(&status.CanvasID, &status.Connected, &status.AutoGenerate, &status.ConnectedSessions, &status.EventSeq)
	return status, err
}

func (s *Service) Execute(ctx context.Context, r Request) (any, error) {
	if strings.HasPrefix(r.Action, "provider_") {
		settings, ok := s.provider.(*ProviderSettings)
		if !ok || r.SessionID != "" || r.WorkspaceID != "" || r.WorkspacePath != "" {
			return nil, invalid("无效的供应商设置操作")
		}
		return settings.execute(ctx, r.Action, r.Data)
	}
	if r.Action == "recover" {
		if r.SessionID != "" || strings.TrimSpace(r.WorkspaceID) == "" {
			return nil, invalid("恢复任务需要 DSH Workspace 身份")
		}
		if err := decodeData(r.Data, &struct{}{}); err != nil {
			return nil, err
		}
		if s.provider == nil {
			return map[string]bool{"recovered": false}, nil
		}
		p, err := s.open(ctx, r.WorkspacePath, false)
		s.wakeWorker()
		return map[string]bool{"recovered": p != nil}, err
	}
	if strings.TrimSpace(r.SessionID) == "" || strings.TrimSpace(r.WorkspaceID) == "" {
		return nil, invalid("需要 DSH Session 和 Workspace 身份")
	}
	var op operation
	switch r.Action {
	case "bind", "disconnect":
		if err := decodeData(r.Data, &op); err != nil {
			return nil, err
		}
		if err := op.validate(); err != nil {
			return nil, err
		}
	case "context", "query", "append", "events", "permission", "submit", "submit_manual", "tasks":
	default:
		return nil, invalid("未知 Studio 操作：%s", r.Action)
	}
	p, err := s.open(ctx, r.WorkspacePath, r.Action == "bind")
	if err != nil {
		return nil, err
	}
	if p == nil {
		if r.Action == "context" {
			return getStatus(ctx, nil, r)
		}
		return nil, notBound
	}
	switch r.Action {
	case "context":
		return getStatus(ctx, p.db, r)
	case "bind", "disconnect":
		return p.bind(ctx, r, op)
	case "query":
		return p.query(ctx, r)
	case "append":
		return p.append(ctx, r)
	case "permission":
		return p.permission(ctx, r)
	case "submit", "submit_manual":
		result, err := p.submit(ctx, r, s.provider)
		if err == nil {
			s.wakeWorker()
		}
		return result, err
	case "tasks":
		return p.tasks(ctx, r)
	default:
		return p.events(ctx, r)
	}
}

type operation struct {
	ID string `json:"operationId"`
}

func (op operation) validate() error {
	if strings.TrimSpace(op.ID) == "" || len(op.ID) > 128 {
		return invalid("需要有效的 operationId")
	}
	return nil
}

func (p *project) write(ctx context.Context, r Request, opID string, apply func(*sql.Tx, Status) (any, error)) (any, error) {
	if err := (operation{ID: opID}).validate(); err != nil {
		return nil, err
	}
	tx, err := p.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	status, err := getStatus(ctx, tx, r)
	if err != nil {
		return nil, err
	}
	if !status.Connected && r.Action != "bind" && r.Action != "disconnect" {
		return nil, notBound
	}
	var session, action string
	var old string
	err = tx.QueryRowContext(ctx, "SELECT session_id,action,result FROM operations WHERE id=?", opID).Scan(&session, &action, &old)
	if err == nil {
		if session != r.SessionID || action != r.Action {
			return nil, &requestError{http.StatusConflict, "operationId 已用于另一操作"}
		}
		return json.RawMessage(old), nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	result, err := apply(tx, status)
	if err != nil {
		return nil, err
	}
	data, err := json.Marshal(result)
	if err != nil {
		return nil, err
	}
	_, err = tx.ExecContext(ctx, "INSERT INTO operations VALUES(?,?,?,?)", opID, r.SessionID, r.Action, string(data))
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	p.notify()
	return result, nil
}

func (p *project) notify() {
	p.mu.Lock()
	close(p.changed)
	p.changed = make(chan struct{})
	p.mu.Unlock()
}

func (p *project) bind(ctx context.Context, r Request, op operation) (any, error) {
	return p.write(ctx, r, op.ID, func(tx *sql.Tx, status Status) (any, error) {
		connected := r.Action == "bind"
		if status.Connected == connected {
			return status, nil
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO session_bindings VALUES(?,?)
  ON CONFLICT(session_id) DO UPDATE SET connected=excluded.connected`, r.SessionID, connected)
		if err != nil {
			return nil, err
		}
		if !connected {
			if _, err := tx.ExecContext(ctx, "DELETE FROM temp.session_permission WHERE session_id=?", r.SessionID); err != nil {
				return nil, err
			}
		}
		if _, err := addEvent(ctx, tx, "binding", []string{r.SessionID}); err != nil {
			return nil, err
		}
		return getStatus(ctx, tx, r)
	})
}

type Event struct {
	EventSeq int64    `json:"eventSeq"`
	CanvasID string   `json:"canvasId"`
	Type     string   `json:"type"`
	IDs      []string `json:"ids"`
}

type eventResult struct {
	Events []Event `json:"events"`
	Status Status  `json:"status"`
}

func addEvent(ctx context.Context, tx *sql.Tx, kind string, ids []string) (int64, error) {
	data, err := json.Marshal(ids)
	if err != nil {
		return 0, err
	}
	result, err := tx.ExecContext(ctx, "INSERT INTO events(type,ids) VALUES(?,?)", kind, string(data))
	if err != nil {
		return 0, err
	}
	return result.LastInsertId()
}

func (p *project) events(ctx context.Context, r Request) (eventResult, error) {
	var args struct {
		After int64 `json:"after"`
	}
	if err := decodeData(r.Data, &args); err != nil {
		return eventResult{}, err
	}
	if args.After < 0 {
		return eventResult{}, invalid("after 必须大于或等于零")
	}
	timer := time.NewTimer(10 * time.Second)
	defer timer.Stop()
	for {
		p.mu.Lock()
		changed := p.changed
		p.mu.Unlock()
		result, err := p.eventSnapshot(ctx, r, args.After)
		if err != nil || len(result.Events) != 0 || result.Status.EventSeq < args.After {
			return result, err
		}
		select {
		case <-ctx.Done():
			return eventResult{}, ctx.Err()
		case <-timer.C:
			return p.eventSnapshot(ctx, r, args.After)
		case <-changed:
		}
	}
}

func (p *project) eventSnapshot(ctx context.Context, r Request, after int64) (eventResult, error) {
	tx, err := p.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return eventResult{}, err
	}
	defer tx.Rollback()
	status, err := getStatus(ctx, tx, r)
	if err != nil {
		return eventResult{}, err
	}
	if !status.Connected {
		return eventResult{}, notBound
	}
	result := eventResult{Events: make([]Event, 0), Status: status}
	rows, err := tx.QueryContext(ctx, "SELECT seq,type,ids FROM events WHERE seq>? ORDER BY seq LIMIT 100", after)
	if err != nil {
		return eventResult{}, err
	}
	defer rows.Close()
	for rows.Next() {
		e := Event{CanvasID: status.CanvasID}
		var ids []byte
		if err := rows.Scan(&e.EventSeq, &e.Type, &ids); err != nil {
			return eventResult{}, err
		}
		if err := json.Unmarshal(ids, &e.IDs); err != nil {
			return eventResult{}, fmt.Errorf("无法读取事件 %d：%w", e.EventSeq, err)
		}
		result.Events = append(result.Events, e)
	}
	return result, rows.Err()
}
