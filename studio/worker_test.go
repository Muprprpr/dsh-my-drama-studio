package studio

import (
	"context"
	"encoding/json"
	"image"
	"image/png"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"
)

type providerFixture struct {
	submit func(GenerationInput) (ProviderSubmission, error)
	poll   func(string) (ProviderResult, error)
}

func (p providerFixture) Prepare(*GenerationInput, string) error    { return nil }
func (p providerFixture) Resolve(ProviderProfile) (Provider, error) { return p, nil }

func (p providerFixture) Submit(_ context.Context, input GenerationInput) (ProviderSubmission, error) {
	return p.submit(input)
}

func (p providerFixture) Poll(_ context.Context, id string) (ProviderResult, error) {
	return p.poll(id)
}

func (p providerFixture) Download(_ context.Context, _ ProviderResult, writer io.Writer) error {
	return png.Encode(writer, image.NewRGBA(image.Rect(0, 0, 2, 2)))
}

func tasksIn(t *testing.T, s *Service, dir, session string) []Task {
	t.Helper()
	return mustCall(t, s, dir, session, "tasks", nil).(map[string][]Task)["tasks"]
}

func recoverProject(t *testing.T, s *Service, dir string) *project {
	t.Helper()
	result, err := s.Execute(context.Background(), Request{WorkspaceID: "workspace", WorkspacePath: dir, Action: "recover"})
	if err != nil || !result.(map[string]bool)["recovered"] {
		t.Fatalf("startup recovery: %+v: %v", result, err)
	}
	if len(s.projects) != 1 {
		t.Fatalf("expected exactly one registered project, got %d", len(s.projects))
	}
	for _, project := range s.projects {
		return project
	}
	t.Fatal("project was not opened")
	return nil
}

func TestGenerationRecoveryAndAppendAfterDisconnect(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	var s *Service
	var submits, polls int
	const providerID = "fixture-known-id"
	fixture := providerFixture{
		submit: func(input GenerationInput) (ProviderSubmission, error) {
			submits++
			if current := tasksIn(t, s, dir, "b")[0].Status; current != "submitting" {
				t.Fatalf("submit called before durable claim: %s", current)
			}
			if input.Prompt != "已内联完整图像提示" || len(input.References) != 1 || input.References[0].URL != "https://images.example/reference.png" {
				t.Fatalf("provider snapshot: %+v", input)
			}
			return ProviderSubmission{TaskID: providerID}, nil
		},
		poll: func(id string) (ProviderResult, error) {
			polls++
			if id != providerID || tasksIn(t, s, dir, "b")[0].ProviderTaskID != id {
				t.Fatalf("polled without durable provider id: %q", id)
			}
			if polls == 1 {
				return ProviderResult{Status: "running"}, nil
			}
			return ProviderResult{Status: "succeeded", Extension: ".png"}, nil
		},
	}
	s = New(fixture)
	t.Cleanup(func() { _ = s.Close() })
	bindSession(t, s, dir, "a")
	bindSession(t, s, dir, "b")
	referenceID, nodeID := uuid.NewString(), uuid.NewString()
	content, err := json.Marshal(map[string]any{"prompt": "已内联完整图像提示", "mixedListOrder": []string{referenceID}})
	if err != nil {
		t.Fatal(err)
	}
	mustCall(t, s, dir, "a", "append", appendArgs{operation: operation{ID: "nodes"}, Nodes: []NodeInput{
		{ID: referenceID, Type: "image", Content: json.RawMessage(`{"url":"https://images.example/reference.png"}`)},
		{ID: nodeID, Type: "image", ShotID: "SH001", Content: content},
	}, Edges: []Edge{{referenceID, nodeID}}})
	request := map[string]any{"operationId": "queue", "nodeId": nodeID, "confirmed": true}
	mustCall(t, s, dir, "a", "submit_manual", request)
	mustCall(t, s, dir, "a", "submit_manual", request)
	if tasks := tasksIn(t, s, dir, "b"); len(tasks) != 1 || tasks[0].Status != "pending" {
		t.Fatalf("expected one persistent pending task: %+v", tasks)
	}
	p, err := s.open(ctx, dir, false)
	if err != nil {
		t.Fatal(err)
	}
	if err := p.advance(ctx, fixture); err != nil {
		t.Fatal(err)
	}
	known := tasksIn(t, s, dir, "b")[0]
	if known.Status != "polling" || known.ProviderTaskID != providerID || submits != 1 || polls != 0 {
		t.Fatalf("provider id not persisted before polling: %+v, submit=%d poll=%d", known, submits, polls)
	}
	_, beforeEdit, err := scanTask(p.db.QueryRowContext(ctx, "SELECT "+taskColumns+" FROM tasks WHERE id=?", known.ID))
	if err != nil {
		t.Fatal(err)
	}
	s.SetHumanWriteCheck(func(context.Context, string, string, []string) (bool, error) { return true, nil })
	edit := updateNodeArgs{
		nodeRevisionArgs: nodeRevisionArgs{operation: operation{ID: "edit-during-poll"}, ID: nodeID, Revision: 1},
		ShotID:           "SH002", Content: json.RawMessage(`{"prompt":"A future shot."}`),
	}
	if _, err := editCall(s, dir, "b", "human", "update_node", edit); err != workspaceBusy {
		t.Fatalf("active task source could be edited: %v", err)
	}
	if _, err := editCall(s, dir, "b", "human", "delete_node", nodeRevisionArgs{
		operation: operation{ID: "delete-during-poll"}, ID: nodeID, Revision: 1,
	}); err != workspaceBusy {
		t.Fatalf("active task source could be deleted: %v", err)
	}
	if _, stored, err := scanTask(p.db.QueryRowContext(ctx, "SELECT "+taskColumns+" FROM tasks WHERE id=?", known.ID)); err != nil || stored != beforeEdit {
		t.Fatalf("source edits modified stored task input: %v", err)
	}
	mustCall(t, s, dir, "a", "disconnect", operation{ID: "disconnect"})
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s = New(fixture)
	p = recoverProject(t, s, dir)
	if err := p.advance(ctx, fixture); err != nil {
		t.Fatal(err)
	}
	// Simulate a file rename that survived a crash before the database commit.
	if _, err := p.download(ctx, known, ProviderResult{Extension: ".png"}, fixture); err != nil {
		t.Fatal(err)
	}
	if err := p.advance(ctx, fixture); err != nil {
		t.Fatal(err)
	}
	finished := tasksIn(t, s, dir, "b")[0]
	if finished.Status != "succeeded" || finished.ResultNodeID == "" || submits != 1 || polls != 2 {
		t.Fatalf("resume: %+v, submit=%d poll=%d", finished, submits, polls)
	}
	query := mustCall(t, s, dir, "b", "query", queryArgs{ID: finished.ResultNodeID}).(queryResult)
	if len(query.Nodes) != 1 || query.Nodes[0].BasedOn != nodeID || query.Nodes[0].CreatedBySession != "a" || query.Nodes[0].ShotID != "SH001" {
		t.Fatalf("result node: %+v", query.Nodes)
	}
	s.SetHumanWriteCheck(func(context.Context, string, string, []string) (bool, error) { return true, nil })
	edited := mustEdit(t, s, dir, "b", "update_node", edit)
	mustEdit(t, s, dir, "b", "delete_node", nodeRevisionArgs{
		operation: operation{ID: "delete-after-poll"}, ID: nodeID, Revision: edited.Revision,
	})
	if source := exactNode(t, s, dir, "b", nodeID); !source.Deleted || source.ShotID != "SH002" {
		t.Fatalf("task source archive lost provenance: %+v", source)
	}
	file, err := os.Open(filepath.Join(dir, "assets", "images", finished.ID+".png"))
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if _, err := png.Decode(file); err != nil {
		t.Fatalf("saved result could not be opened: %v", err)
	}
	t.Log("fixture only: pending, durable submitting and task ID, restart polling, source protected during polling, editable after completion, original input and shot snapshot preserved, downloaded real PNG bytes and appended result after Session disconnect")
}

func TestUncertainGenerationNeverResubmits(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	var submits int
	fixture := providerFixture{submit: func(GenerationInput) (ProviderSubmission, error) {
		submits++
		return ProviderSubmission{}, context.DeadlineExceeded
	}}
	s := New(fixture)
	t.Cleanup(func() { _ = s.Close() })
	bindSession(t, s, dir, "a")
	nodeID := uuid.NewString()
	mustCall(t, s, dir, "a", "append", appendArgs{operation: operation{ID: "node"}, Nodes: []NodeInput{
		{ID: nodeID, Type: "video", Content: json.RawMessage(`{"prompt":"镜头缓慢推进。"}`)},
	}})
	mustCall(t, s, dir, "a", "submit_manual", map[string]any{"operationId": "will-timeout", "nodeId": nodeID, "confirmed": true})
	p, err := s.open(ctx, dir, false)
	if err != nil {
		t.Fatal(err)
	}
	if err := p.advance(ctx, fixture); err != nil {
		t.Fatal(err)
	}
	first := tasksIn(t, s, dir, "a")[0]
	if first.Status != "uncertain" || first.ProviderTaskID != "" || !strings.Contains(first.Error, "timed out") {
		t.Fatalf("lost acknowledgement state: %+v", first)
	}
	mustCall(t, s, dir, "a", "submit_manual", map[string]any{"operationId": "will-interrupt", "nodeId": nodeID, "confirmed": true})
	second := tasksIn(t, s, dir, "a")[0]
	if err := p.transition(ctx, second, "submitting", "", ""); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s = New(fixture)
	p = recoverProject(t, s, dir)
	for range 2 {
		if err := p.advance(ctx, fixture); err != nil {
			t.Fatal(err)
		}
	}
	for _, task := range tasksIn(t, s, dir, "a") {
		if task.Status != "uncertain" || !strings.Contains(task.Error, "Confirm with provider") {
			t.Fatalf("recovered task: %+v", task)
		}
	}
	if submits != 1 {
		t.Fatalf("uncertain tasks called submit %d times", submits)
	}
	t.Log("fixture only: timed-out POST and interrupted submitting state both require explicit provider reconciliation, with no automatic retry")
}

func TestGenerationRejectsLoopbackReferenceAndOutputTraversal(t *testing.T) {
	for _, value := range []string{
		"http://127.0.0.1/x", "http://127.1/x", "http://localhost./x", "http://alias.localhost/x",
		"http://[::1]/x", "http://[::ffff:127.0.0.1]/x", "http://2130706433/x", "http://0x7f.0.0.1/x",
		"http://10.1.2.3/x", "file:///image.png", "assets/images/photo.png",
	} {
		if providerURL(value) {
			t.Errorf("private or local reference accepted: %s", value)
		}
	}
	if !providerURL("https://example.com/reference.png") {
		t.Fatal("public HTTPS reference rejected")
	}
	dir := t.TempDir()
	fixture := providerFixture{}
	s := New(fixture)
	defer s.Close()
	bindSession(t, s, dir, "a")
	media, video := uuid.NewString(), uuid.NewString()
	content, err := json.Marshal(map[string]any{"prompt": "按 @图片1 构图。", "mixedListOrder": []string{media}})
	if err != nil {
		t.Fatal(err)
	}
	mustCall(t, s, dir, "a", "append", appendArgs{operation: operation{ID: "nodes"}, Nodes: []NodeInput{
		{ID: media, Type: "image", Content: json.RawMessage(`{"url":"http://127.0.0.1:9000/preview.png"}`)},
		{ID: video, Type: "video", Content: content},
	}, Edges: []Edge{{media, video}}})
	if _, err := call(s, dir, "a", "submit_manual", map[string]any{"operationId": "private", "nodeId": video, "confirmed": true}); err == nil || !strings.Contains(err.Error(), "外部 HTTP/HTTPS") {
		t.Fatalf("submission accepted a loopback preview: %v", err)
	}
	if tasks := tasksIn(t, s, dir, "a"); len(tasks) != 0 {
		t.Fatalf("invalid reference queued a task: %+v", tasks)
	}
	p, err := s.open(context.Background(), dir, false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.download(context.Background(), Task{ID: uuid.NewString(), Type: "image"}, ProviderResult{Extension: "../../outside.png"}, fixture); err == nil {
		t.Fatal("provider-controlled path traversal accepted")
	}
	t.Log("private URLs usable as previews cannot reach a provider, and provider-controlled path traversal is rejected")
}

func TestTaskMetadataMigrationPreservesHistoricalResult(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	service := New(providerFixture{})
	bindSession(t, service, dir, "a")
	draft, output, taskID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	const saved = "assets/videos/legacy.mp4"
	mustCall(t, service, dir, "a", "append", appendArgs{operation: operation{ID: "historical"}, Nodes: []NodeInput{
		{ID: draft, Type: "video", Content: json.RawMessage(`{"mode":"t2v","prompt":"Historical complete prompt."}`)},
		{ID: output, Type: "video", BasedOn: draft, Content: json.RawMessage(`{"path":"` + saved + `"}`)},
	}})
	project, err := service.open(ctx, dir, false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := project.db.ExecContext(ctx, `ALTER TABLE tasks DROP COLUMN completed_at;
		ALTER TABLE tasks DROP COLUMN output_path;
		INSERT INTO tasks(id,node_id,session_id,type,status,input,provider_id,result_node_id,created_at,updated_at)
		VALUES(?,?,'a','video','succeeded','{"mode":"t2v"}','legacy-task',?,'2025-01-01','2025-01-02')`, taskID, draft, output); err != nil {
		t.Fatal(err)
	}
	if err := service.Close(); err != nil {
		t.Fatal(err)
	}
	service = New(providerFixture{})
	defer service.Close()
	recoverProject(t, service, dir)
	task := tasksIn(t, service, dir, "a")[0]
	if task.ID != taskID || task.OutputPath != saved || task.CompletedAt != "2025-01-02" || task.ResultNodeID != output {
		t.Fatalf("historical task metadata: %+v", task)
	}
}
