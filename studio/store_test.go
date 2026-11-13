package studio

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
)

func call(s *Service, dir, session, action string, data any) (any, error) {
	encoded, err := json.Marshal(data)
	if err != nil {
		return nil, err
	}
	return s.Execute(context.Background(), Request{
		SessionID: session, WorkspaceID: "native-workspace", WorkspacePath: dir, Action: action, Data: encoded,
	})
}

func mustCall(t *testing.T, s *Service, dir, session, action string, data any) any {
	t.Helper()
	result, err := call(s, dir, session, action, data)
	if err != nil {
		t.Fatalf("%s/%s: %v", session, action, err)
	}
	return result
}

func bindSession(t *testing.T, s *Service, dir, session string) Status {
	t.Helper()
	return mustCall(t, s, dir, session, "bind", operation{ID: uuid.NewString()}).(Status)
}

func TestWorkspaceIdentityConcurrencyAndRestart(t *testing.T) {
	dir, other := filepath.Join(t.TempDir(), "短剧 #100%"), t.TempDir()
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	s := New(nil)
	t.Cleanup(func() { _ = s.Close() })
	status := mustCall(t, s, dir, "a", "context", nil).(Status)
	if status.Connected || status.AutoGenerate || status.CanvasID != "" {
		t.Fatalf("new session status: %+v", status)
	}
	if _, err := os.Stat(filepath.Join(dir, ".drama-studio")); !os.IsNotExist(err) {
		t.Fatalf("context created project state: %v", err)
	}
	a := bindSession(t, s, dir, "a")
	alias := dir + string(os.PathSeparator) + "."
	if runtime.GOOS == "windows" {
		alias = strings.ToUpper(alias)
	}
	b, c := bindSession(t, s, alias, "b"), bindSession(t, s, dir, "c")
	x := bindSession(t, s, other, "x")
	if a.CanvasID == "" || b.CanvasID != a.CanvasID || c.CanvasID != a.CanvasID || x.CanvasID == a.CanvasID || c.ConnectedSessions != 3 {
		t.Fatalf("workspace identities: a=%+v b=%+v c=%+v x=%+v", a, b, c, x)
	}
	if _, err := call(s, other, "a", "query", nil); err != notBound {
		t.Fatalf("cross-workspace query: %v", err)
	}
	var group sync.WaitGroup
	errs := make(chan error, 2)
	for _, session := range []string{"a", "b"} {
		group.Add(1)
		go func(session string) {
			defer group.Done()
			for i := 0; i < 50; i++ {
				args := appendArgs{operation: operation{ID: fmt.Sprintf("%s-%d", session, i)}, Nodes: []NodeInput{{Type: "shot", ShotID: "SH01", Content: json.RawMessage(`{"description":"original"}`)}}}
				if _, err := call(s, dir, session, "append", args); err != nil {
					errs <- err
					return
				}
			}
		}(session)
	}
	group.Wait()
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
	replayed := mustCall(t, s, dir, "a", "append", appendArgs{operation: operation{ID: "a-0"}}).(json.RawMessage)
	var original appendResult
	if err := json.Unmarshal(replayed, &original); err != nil || len(original.IDs) != 1 {
		t.Fatalf("idempotent reply: %s (%v)", replayed, err)
	}
	result := mustCall(t, s, dir, "c", "query", queryArgs{ShotID: "SH01", Q: "Original"}).(queryResult)
	if len(result.Nodes) != 100 || result.HasMore {
		t.Fatalf("expected exactly 100 nodes, got %d, more=%v", len(result.Nodes), result.HasMore)
	}
	for _, session := range []string{"a", "b"} {
		filtered := mustCall(t, s, dir, "c", "query", queryArgs{CreatedBySession: session}).(queryResult)
		if len(filtered.Nodes) != 50 {
			t.Fatalf("%s contributed %d nodes", session, len(filtered.Nodes))
		}
	}
	page := mustCall(t, s, dir, "c", "query", queryArgs{Limit: 20, Offset: 70}).(queryResult)
	if len(page.Nodes) != 20 || !page.HasMore {
		t.Fatalf("pagination: %d, more=%v", len(page.Nodes), page.HasMore)
	}
	p, err := s.open(context.Background(), dir, false)
	if err != nil {
		t.Fatal(err)
	}
	var journal string
	if err := p.db.QueryRow("PRAGMA journal_mode").Scan(&journal); err != nil || journal != "wal" {
		t.Fatalf("journal=%q: %v", journal, err)
	}
	for _, node := range result.Nodes {
		if node.Revision != 1 || node.Deleted {
			t.Fatalf("new row initialized incorrectly: %+v", node)
		}
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	cloned := t.TempDir()
	cloneState := filepath.Join(cloned, ".drama-studio")
	if err := os.Mkdir(cloneState, 0o700); err != nil {
		t.Fatal(err)
	}
	contents, err := os.ReadFile(filepath.Join(dir, ".drama-studio", "studio.db"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cloneState, "studio.db"), contents, 0o600); err != nil {
		t.Fatal(err)
	}
	s = New(nil)
	afterRestart := mustCall(t, s, dir, "a", "query", queryArgs{ID: original.IDs[0]}).(queryResult)
	if len(afterRestart.Nodes) != 1 || afterRestart.Status.CanvasID != a.CanvasID {
		t.Fatalf("restart did not restore data: %+v", afterRestart)
	}
	if clonedStatus := bindSession(t, s, cloned, "copy"); clonedStatus.CanvasID != a.CanvasID {
		t.Fatalf("copied database changed Canvas ID: %+v", clonedStatus)
	}
	disconnected := mustCall(t, s, dir, "a", "disconnect", operation{ID: "disconnect-a"}).(Status)
	if disconnected.Connected || disconnected.ConnectedSessions != 2 {
		t.Fatalf("disconnect: %+v", disconnected)
	}
	if _, err := call(s, dir, "a", "append", appendArgs{operation: operation{ID: "a-new"}}); err != notBound {
		t.Fatalf("disconnected append: %v", err)
	}
	if result := mustCall(t, s, dir, "b", "query", nil).(queryResult); len(result.Nodes) != 100 {
		t.Fatalf("disconnect modified shared history: %d nodes", len(result.Nodes))
	}
	t.Log("three native identities share one Canvas, separate Workspace isolated, 2×50 retained, retry idempotent, WAL and initial revisions verified, restart and project copy preserved Canvas")
}

func TestImportedMediaMetadataPersistsAcrossRestart(t *testing.T) {
	dir := t.TempDir()
	s := New(nil)
	defer func() { _ = s.Close() }()
	bindSession(t, s, dir, "a")
	assetID := uuid.NewString() + ".MP4"
	content := json.RawMessage(fmt.Sprintf(`{"assetId":%q,"path":%q,"canvasPosition":{"x":-13.5,"y":0},"title":"原始文件.MP4"}`,
		assetID, "assets/videos/"+assetID))
	appended := mustCall(t, s, dir, "a", "append", appendArgs{operation: operation{ID: "import"},
		Nodes: []NodeInput{{Type: "video", Content: content}}}).(appendResult)
	for _, raw := range []string{
		`{"assetId":"../outside.mp4","path":"assets/videos/clip.mp4"}`,
		fmt.Sprintf(`{"assetId":%q,"path":"assets/videos/another.mp4"}`, assetID),
		`{"canvasPosition":{"x":null,"y":0}}`,
		`{"canvasPosition":{"x":1e1000,"y":0}}`,
	} {
		if err := validateNode(NodeInput{Type: "video", Content: json.RawMessage(raw)}); err == nil {
			t.Errorf("invalid media metadata accepted: %s", raw)
		}
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s = New(nil)
	result := mustCall(t, s, dir, "a", "query", queryArgs{ID: appended.IDs[0]}).(queryResult)
	if len(result.Nodes) != 1 || !bytes.Equal(result.Nodes[0].Content, content) {
		t.Fatalf("imported media metadata was not restored: %+v", result.Nodes)
	}
}

func TestAtomicReferencesAndVideoPrompt(t *testing.T) {
	dir, other := t.TempDir(), t.TempDir()
	s := New(nil)
	defer s.Close()
	bindSession(t, s, dir, "a")
	bindSession(t, s, dir, "b")
	bindSession(t, s, other, "x")
	note := NodeInput{ID: uuid.NewString(), Type: "note", Content: json.RawMessage(`{"description":"source"}`)}
	image := NodeInput{ID: uuid.NewString(), Type: "image", Content: json.RawMessage(`{"path":"assets/images/reference.jpg"}`)}
	draft := NodeInput{ID: uuid.NewString(), Type: "image", Content: json.RawMessage(`{"prompt":"no stored media"}`)}
	foreign := NodeInput{ID: uuid.NewString(), Type: "image", Content: json.RawMessage(`{"url":"https://example.com/reference.jpg"}`)}
	mustCall(t, s, dir, "a", "append", appendArgs{operation: operation{ID: "sources"}, Nodes: []NodeInput{note, image, draft}})
	mustCall(t, s, other, "x", "append", appendArgs{operation: operation{ID: "foreign"}, Nodes: []NodeInput{foreign}})
	video := NodeInput{ID: uuid.NewString(), Type: "video", Content: json.RawMessage(fmt.Sprintf(`{"prompt":"参照 @图片1，演员放下手中的杯子。","textList":[],"mixedListOrder":[%q]}`, image.ID))}
	for _, tc := range []struct {
		name    string
		node    NodeInput
		source  string
		message string
	}{
		{"text edge", video, note.ID, "只接受媒体"},
		{"cross-canvas edge", video, foreign.ID, "不存在于当前 Canvas"},
		{"unresolved media", video, draft.ID, "媒体 URL 或相对文件"},
		{"text list", NodeInput{ID: video.ID, Type: "video", Content: json.RawMessage(`{"prompt":"文字","textList":["extra"]}`)}, image.ID, "textList"},
		{"missing order", NodeInput{ID: video.ID, Type: "video", Content: json.RawMessage(`{"prompt":"看 @图片1"}`)}, image.ID, "mixedListOrder"},
		{"placeholder", NodeInput{ID: video.ID, Type: "video", Content: json.RawMessage(fmt.Sprintf(`{"prompt":"看 @图片2","mixedListOrder":[%q]}`, image.ID))}, image.ID, "没有对应"},
		{"missing prompt", NodeInput{ID: video.ID, Type: "video", Content: json.RawMessage(`{}`)}, image.ID, "内联完整提示词"},
	} {
		_, err := call(s, dir, "b", "append", appendArgs{operation: operation{ID: tc.name}, Nodes: []NodeInput{tc.node}, Edges: []Edge{{tc.source, tc.node.ID}}})
		if err == nil || !strings.Contains(err.Error(), tc.message) {
			t.Fatalf("%s: %v", tc.name, err)
		}
		result := mustCall(t, s, dir, "a", "query", nil).(queryResult)
		if len(result.Nodes) != 3 || len(result.Edges) != 0 {
			t.Fatalf("%s did not roll back: %+v", tc.name, result)
		}
	}
	video.BasedOn = note.ID
	mustCall(t, s, dir, "b", "append", appendArgs{operation: operation{ID: "video"}, Nodes: []NodeInput{video}, Edges: []Edge{{image.ID, video.ID}}})
	result := mustCall(t, s, dir, "a", "query", nil).(queryResult)
	if len(result.Nodes) != 4 || len(result.Edges) != 1 || result.Nodes[0].BasedOn != note.ID || result.Nodes[0].CreatedBySession != "b" {
		t.Fatalf("append-only revision: %+v", result)
	}
	t.Log("failed references rolled back, cross-Canvas reference denied, video prompt/ordered media validated, revision provenance retained")
}

func TestEventsResumeAndHostAuthentication(t *testing.T) {
	dir := t.TempDir()
	s := New(nil)
	defer s.Close()
	bindSession(t, s, dir, "a")
	start := bindSession(t, s, dir, "b")
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	r := Request{SessionID: "b", WorkspaceID: start.WorkspaceID, WorkspacePath: dir, Action: "events", Data: json.RawMessage(fmt.Sprintf(`{"after":%d}`, start.EventSeq))}
	observed := make(chan any, 1)
	go func() {
		result, err := s.Execute(ctx, r)
		if err != nil {
			observed <- err
			return
		}
		observed <- result
	}()
	newNode := NodeInput{Type: "note", Content: json.RawMessage(`{"description":"visible to b"}`)}
	added := mustCall(t, s, dir, "a", "append", appendArgs{operation: operation{ID: "visible"}, Nodes: []NodeInput{newNode}}).(appendResult)
	events, ok := (<-observed).(eventResult)
	if !ok || len(events.Events) != 1 || events.Events[0].EventSeq != added.EventSeq || events.Events[0].CanvasID != start.CanvasID {
		t.Fatalf("live events: %+v", events)
	}
	backlog, err := s.Execute(ctx, r)
	if err != nil || len(backlog.(eventResult).Events) != 1 {
		t.Fatalf("event resume: %+v, %v", backlog, err)
	}
	for _, tc := range []struct {
		token string
		data  string
		code  int
	}{
		{"bad", ``, http.StatusUnauthorized},
		{"fixture", `{"sessionId":"a","workspaceId":"workspace","workspacePath":"./relative","action":"context"}`, http.StatusBadRequest},
		{"fixture", fmt.Sprintf(`{"sessionId":"a","workspaceId":"workspace","workspacePath":%q,"action":"append","data":{"operationId":"forged","sessionId":"b"}}`, filepath.ToSlash(dir)), http.StatusBadRequest},
	} {
		request := httptest.NewRequest(http.MethodPost, "/", bytes.NewBufferString(tc.data))
		request.Header.Set("Authorization", "Bearer "+tc.token)
		response := httptest.NewRecorder()
		s.Handler("fixture").ServeHTTP(response, request)
		if response.Code != tc.code {
			t.Fatalf("authentication/identity: %d, want %d: %s", response.Code, tc.code, response.Body)
		}
	}
	t.Log("other Session woke on commit, reconnect replayed event, private IPC rejected missing token and injected session field")
}

func TestCanvasQuerySearchAndTaskFilter(t *testing.T) {
	s := New(nil)
	defer s.Close()
	dir := t.TempDir()
	bindSession(t, s, dir, "a")
	id := uuid.NewString()
	mustCall(t, s, dir, "a", "append", appendArgs{operation: operation{ID: "search-node"}, Nodes: []NodeInput{
		{ID: id, Type: "shot", ShotID: "SH-0049", Content: json.RawMessage("{\"title\":\"Arrival at the gate\"}")},
	}})
	for _, query := range []string{id[:10], "sh-0049", "arrival"} {
		got := mustCall(t, s, dir, "a", "query", queryArgs{Q: query}).(queryResult)
		if len(got.Nodes) != 1 || got.Nodes[0].ID != id {
			t.Fatalf("search %q returned %+v", query, got.Nodes)
		}
	}
	p, err := s.open(context.Background(), dir, false)
	if err != nil {
		t.Fatal(err)
	}
	for _, status := range []string{"failed", "polling"} {
		if _, err := p.db.Exec("INSERT INTO tasks(id,node_id,session_id,type,status,input,created_at,updated_at) VALUES(?,?,?,?,?,'{}','','')",
			uuid.NewString(), id, "a", "video", status); err != nil {
			t.Fatal(err)
		}
	}
	for _, tc := range []struct {
		state string
		want  int
	}{{"polling", 1}, {"failed", 0}} {
		got := mustCall(t, s, dir, "a", "query", queryArgs{TaskStatus: tc.state}).(queryResult)
		if len(got.Nodes) != tc.want {
			t.Fatalf("task status %q returned %d nodes, expected %d", tc.state, len(got.Nodes), tc.want)
		}
	}
}
