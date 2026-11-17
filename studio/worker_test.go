package studio

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"image"
	"image/png"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestFrozenProjectMediaRejectsSamePathReplacement(t *testing.T) {
	for _, tc := range []struct {
		name    string
		replace bool
	}{
		{"replaced second reference prevents all channel calls", true},
		{"unchanged references stay write-protected through upload", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			const first = "assets/images/first.png"
			const second = "assets/audio/sound.wav"
			const audio = "RIFF\x28\x00\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00\x40\x1f\x00\x00\x80\x3e\x00\x00\x02\x00\x10\x00data\x04\x00\x00\x00\xff\x1f\x01\x00"
			dir := t.TempDir()
			var frame bytes.Buffer
			if err := png.Encode(&frame, image.NewRGBA(image.Rect(0, 0, 8, 8))); err != nil {
				t.Fatal(err)
			}
			for path, content := range map[string][]byte{first: frame.Bytes(), second: []byte(audio)} {
				file := filepath.Join(dir, filepath.FromSlash(path))
				if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(file, content, 0o600); err != nil {
					t.Fatal(err)
				}
			}
			settings, err := OpenProfileSettings("")
			if err != nil {
				t.Fatal(err)
			}
			const channel = "local-media-freeze"
			settings.data.Channels = []VideoChannel{{ID: channel, Name: "H3 fixture", Protocol: minimaxH3Protocol}}
			settings.data.Profiles = []ProviderProfile{{
				ID: uuid.NewString(), Name: "H3 fixture", ChannelID: channel, Model: minimaxH3Model, Modes: []string{"r2v"},
				Limits: VideoLimits{References: map[string]int{"image": 1, "audio": 1}, MaxReferences: 2},
			}}
			settings.data.Keys[channel] = "fixture-not-a-live-token"
			uploads, submits := 0, 0
			settings.client.Transport = testTransport(func(req *http.Request) (*http.Response, error) {
				if tc.replace {
					t.Fatalf("changed local file reached the HTTP boundary: %s %s", req.Method, req.URL.Path)
				}
				switch req.Method + " " + req.URL.Path {
				case "POST /api/minimax" + minimaxH3Upload:
					uploads++
					if uploads > 2 {
						t.Fatalf("unexpected additional media upload: %d", uploads)
					}
					for _, path := range []string{first, second} {
						writer, err := os.OpenFile(filepath.Join(dir, filepath.FromSlash(path)), os.O_WRONLY, 0)
						if err == nil {
							writer.Close()
							t.Fatalf("adapter is uploading while %q can be opened for writing", path)
						}
					}
					body, err := io.ReadAll(req.Body)
					want := [][]byte{frame.Bytes(), []byte(audio)}[uploads-1]
					if err != nil || !bytes.Contains(body, want) {
						t.Fatalf("upload %d did not read the frozen file bytes: %v", uploads, err)
					}
					return arkFixtureResponse(http.StatusOK, fmt.Sprintf(`{"file":{"file_id":%d}}`, uploads))
				case "POST /api/minimax" + minimaxH3Submit:
					submits++
					return arkFixtureResponse(http.StatusOK, `{"task_id":"4191234567891234"}`)
				default:
					t.Fatalf("unexpected channel request: %s %s", req.Method, req.URL)
					return nil, nil
				}
			})
			service := New(settings)
			defer service.Close()
			bindSession(t, service, dir, "a")
			firstID, secondID, videoID := uuid.NewString(), uuid.NewString(), uuid.NewString()
			mustCall(t, service, dir, "a", "append", appendArgs{operation: operation{ID: "local-media-draft"}, Nodes: []NodeInput{
				{ID: firstID, Type: "image", Content: json.RawMessage(`{"path":"` + first + `"}`)},
				{ID: secondID, Type: "audio", Content: json.RawMessage(`{"path":"` + second + `"}`)},
				{ID: videoID, Type: "video", Content: encodeMentionFixture(t, map[string]any{
					"mode": "r2v", "prompt": "Maintain the framing and sound.",
					"mixedListOrder": []string{firstID, secondID},
				})},
			}, Edges: []Edge{{firstID, videoID}, {secondID, videoID}}})
			mustCall(t, service, dir, "a", "generateR2V", map[string]any{"operationId": "queue", "nodeId": videoID, "confirmed": true})
			p, err := service.open(context.Background(), dir, false)
			if err != nil {
				t.Fatal(err)
			}
			task, stored, err := scanTask(p.db.QueryRow("SELECT " + taskColumns + " FROM tasks"))
			if err != nil || task.Status != "pending" {
				t.Fatalf("task did not queue: %+v (%v)", task, err)
			}
			var snapshot generationRequest
			if err := json.Unmarshal([]byte(stored), &snapshot); err != nil || len(snapshot.References) != 2 ||
				snapshot.References[0].LocalSHA256 != fmt.Sprintf("%x", sha256.Sum256(frame.Bytes())) ||
				snapshot.References[1].LocalSHA256 != fmt.Sprintf("%x", sha256.Sum256([]byte(audio))) {
				t.Fatalf("snapshot did not freeze local media bytes: %s (%v)", stored, err)
			}
			if tc.replace {
				file := filepath.Join(dir, filepath.FromSlash(second))
				info, err := os.Stat(file)
				if err != nil {
					t.Fatal(err)
				}
				modified := []byte(audio)
				modified[len(modified)-1] ^= 1
				replacement := file + ".replacement"
				if err := os.WriteFile(replacement, modified, 0o600); err != nil {
					t.Fatal(err)
				}
				if err := os.Chtimes(replacement, info.ModTime(), info.ModTime()); err != nil {
					t.Fatal(err)
				}
				if err := os.Rename(replacement, file); err != nil {
					t.Fatal(err)
				}
			}
			if err := p.advance(context.Background(), settings); err != nil {
				t.Fatal(err)
			}
			current, after, err := scanTask(p.db.QueryRow("SELECT " + taskColumns + " FROM tasks"))
			if err != nil || after != stored || current.ID != task.ID {
				t.Fatalf("task snapshot changed: %+v (%v)", current, err)
			}
			if tc.replace {
				if uploads != 0 || submits != 0 || current.Status != "failed" ||
					!strings.Contains(current.Error, second) || !strings.Contains(current.Error, "冻结的文件内容") {
					t.Fatalf("changed media was not safely rejected: %+v, uploads=%d submits=%d", current, uploads, submits)
				}
			} else if uploads != 2 || submits != 1 || current.Status != "polling" || current.ProviderTaskID == "" {
				t.Fatalf("valid frozen files did not reach the channel: %+v, uploads=%d submits=%d", current, uploads, submits)
			}
		})
	}
}

func queueReplicateSettings(t *testing.T, profile ProviderProfile, transport testTransport) *ProviderSettings {
	t.Helper()
	settings, err := OpenProfileSettings("")
	if err != nil {
		t.Fatal(err)
	}
	settings.data.Profiles = []ProviderProfile{profile}
	settings.data.Channels = []VideoChannel{{ID: "replicate", Name: "Replicate", Protocol: "replicate"}}
	settings.data.Keys["replicate"] = "fixture-not-a-live-token"
	settings.client.Transport = transport
	return settings
}

func TestQueuedVideoSendsFrozenUpstreamVersion(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	const prompt = "  光线映在窗边。\n人物说：开始。\n最后一帧停住。\n"
	const firstURL = "https://images.example/first.png"
	const newerURL = "https://images.example/newer.png"
	profile := ProviderProfile{ID: uuid.NewString(), Name: "Image to video fixture",
		Provider: "replicate", ChannelID: "replicate", Modes: []string{"i2v"},
		Model: "kwaivgi/kling-v2.5-turbo-pro", InputField: "start_image"}
	var sends int
	settings := queueReplicateSettings(t, profile, func(req *http.Request) (*http.Response, error) {
		sends++
		if req.Method != http.MethodPost || req.URL.Host != "api.replicate.com" ||
			req.URL.Path != "/v1/models/"+profile.Model+"/predictions" {
			t.Fatalf("unexpected channel request: %s %s", req.Method, req.URL)
		}
		var payload replicatePredictionInput
		if err := json.NewDecoder(req.Body).Decode(&payload); err != nil {
			t.Fatal(err)
		}
		if payload.Input["prompt"] != prompt || payload.Input["start_image"] != firstURL {
			t.Fatalf("channel did not send frozen prompt and first result: %+v", payload)
		}
		return &http.Response{StatusCode: http.StatusCreated, Header: make(http.Header),
			Body: io.NopCloser(strings.NewReader(`{"id":"frozen-receipt","status":"starting"}`))}, nil
	})
	service := New(settings)
	defer service.Close()
	bindSession(t, service, dir, "a")
	service.SetHumanWriteCheck(func(context.Context, string, string, []string) (bool, error) { return true, nil })
	sourceID, firstID, newerID, videoID := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	draft, err := json.Marshal(map[string]any{"mode": "i2v", "prompt": prompt, "mixedListOrder": []string{sourceID}})
	if err != nil {
		t.Fatal(err)
	}
	mustCall(t, service, dir, "a", "append", appendArgs{operation: operation{ID: "first-drafts"}, Nodes: []NodeInput{
		{ID: sourceID, Type: "image", Content: json.RawMessage(`{"prompt":"First frame"}`)},
		{ID: firstID, Type: "image", BasedOn: sourceID, Content: json.RawMessage(`{"url":"` + firstURL + `"}`)},
	}})
	p, err := service.open(ctx, dir, false)
	if err != nil {
		t.Fatal(err)
	}
	recordResult := func(outputID string) {
		t.Helper()
		if _, err := p.db.ExecContext(ctx, `INSERT INTO tasks(id,node_id,session_id,type,status,input,result_node_id,created_at,updated_at)
			VALUES(?,?,'a','image','succeeded','{}',?,'','')`, uuid.NewString(), sourceID, outputID); err != nil {
			t.Fatal(err)
		}
	}
	recordResult(firstID)
	if _, err := editCall(service, dir, "a", "human", "append", appendArgs{operation: operation{ID: "video-draft"}, Nodes: []NodeInput{
		{ID: videoID, Type: "video", Content: draft},
	}, Edges: []Edge{{sourceID, videoID}}}); err != nil {
		t.Fatal(err)
	}
	args := map[string]any{"operationId": "freeze-video", "nodeId": videoID, "confirmed": true}
	mustCall(t, service, dir, "a", "submit_manual", args)
	before, snapshot, err := scanTask(p.db.QueryRow("SELECT " + taskColumns + " FROM tasks WHERE type='video'"))
	if err != nil || before.Status != "pending" {
		t.Fatalf("pending snapshot: %+v, %v", before, err)
	}
	var frozen generationRequest
	if err := json.Unmarshal([]byte(snapshot), &frozen); err != nil || frozen.Prompt != prompt ||
		frozen.VideoInputContract != videoInputContractVersion || len(frozen.References) != 1 {
		t.Fatalf("wrong stored input: %s (%v)", snapshot, err)
	}
	if ref := frozen.References[0]; ref.URL != firstURL || ref.SourceNodeID != sourceID ||
		ref.ResultNodeID != firstID || ref.Role != "first_frame" || ref.ResultRevision == 0 {
		t.Fatalf("missing input version or role: %+v", ref)
	}
	mustCall(t, service, dir, "a", "append", appendArgs{operation: operation{ID: "newer-source-result"}, Nodes: []NodeInput{
		{ID: newerID, Type: "image", BasedOn: sourceID, Content: json.RawMessage(`{"url":"` + newerURL + `"}`)},
	}})
	recordResult(newerID)
	// Emulate a changed canvas on disk at recovery. Ordinary edits to active
	// task sources are still protected by the service's workspace write checks.
	if _, err := p.db.ExecContext(ctx, `DELETE FROM edges WHERE target=?;
		UPDATE nodes SET content=json_set(content,'$.prompt','Edited canvas text') WHERE id=?;
		UPDATE nodes SET deleted=1 WHERE id=?`, videoID, videoID, firstID); err != nil {
		t.Fatal(err)
	}
	mustCall(t, service, dir, "a", "submit_manual", args)
	if err := p.advance(ctx, settings); err != nil {
		t.Fatal(err)
	}
	after, stored, err := scanTask(p.db.QueryRow("SELECT " + taskColumns + " FROM tasks WHERE type='video'"))
	if err != nil || sends != 1 || after.ID != before.ID || after.Status != "polling" || after.ProviderTaskID != "frozen-receipt" || stored != snapshot {
		t.Fatalf("frozen task was replaced or rewritten: %+v, sends=%d, %v", after, sends, err)
	}
}

func TestRecoveredVideoRequiresInputContractOnlyToSubmit(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	profile := ProviderProfile{ID: uuid.NewString(), Name: "Legacy fixture",
		Provider: "replicate", ChannelID: "replicate", Mode: "t2v", Modes: []string{"t2v"},
		Model: "wan-video/wan-2.7-t2v"}
	var polls, downloads int
	settings := queueReplicateSettings(t, profile, func(req *http.Request) (*http.Response, error) {
		var body string
		status := http.StatusOK
		switch req.Method + " " + req.URL.Host + req.URL.Path {
		case "GET api.replicate.com/v1/predictions/known-legacy-id":
			polls++
			if polls == 1 {
				status, body = http.StatusServiceUnavailable, `{"detail":"transient upstream error"}`
			} else {
				body = `{"id":"known-legacy-id","status":"succeeded","output":"https://replicate.delivery/test/kept.mp4"}`
			}
		case "GET replicate.delivery/test/kept.mp4":
			downloads++
			body = string(protocolTestVideo)
		default:
			t.Fatalf("historical task made an unexpected channel call: %s %s", req.Method, req.URL)
		}
		return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}, nil
	})
	service := New(settings)
	bindSession(t, service, dir, "a")
	nodeID, archivedID, knownID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	const historyPath = "assets/videos/saved-history.mp4"
	mustCall(t, service, dir, "a", "append", appendArgs{operation: operation{ID: "current"}, Nodes: []NodeInput{
		{ID: nodeID, Type: "video", Content: json.RawMessage(`{"mode":"t2v","prompt":"Current canvas prompt"}`)},
		{ID: archivedID, Type: "video", BasedOn: nodeID, Content: json.RawMessage(`{"path":"` + historyPath + `"}`)},
	}})
	if err := os.MkdirAll(filepath.Join(dir, "assets", "videos"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, filepath.FromSlash(historyPath)), protocolTestVideo, 0o600); err != nil {
		t.Fatal(err)
	}
	p, err := service.open(ctx, dir, false)
	if err != nil {
		t.Fatal(err)
	}
	legacy := generationRequest{GenerationInput: GenerationInput{Type: "video", Mode: "t2v", Profile: profile, Prompt: "Legacy prompt"}}
	proofless, err := json.Marshal(legacy)
	if err != nil {
		t.Fatal(err)
	}
	legacy.References = []GenerationReference{{Type: "image", URL: "https://images.example/old-unconnected.png"}}
	violating, err := json.Marshal(legacy)
	if err != nil {
		t.Fatal(err)
	}
	snapshots := map[string][]byte{
		"proofless": proofless, "violating": violating, "interrupted": violating,
		knownID: violating, "history": proofless,
	}
	for _, row := range []struct{ id, status, providerID, resultID, outputPath string }{
		{id: "proofless", status: "pending"},
		{id: "violating", status: "pending"},
		{id: "interrupted", status: "submitting"},
		{id: knownID, status: "paused", providerID: "known-legacy-id"},
		{id: "history", status: "succeeded", providerID: "older-legacy-id", resultID: archivedID, outputPath: historyPath},
	} {
		if _, err := p.db.ExecContext(ctx, `INSERT INTO tasks(id,node_id,session_id,type,status,input,provider_id,result_node_id,output_path,created_at,updated_at)
			VALUES(?,?,'a','video',?,?,?,?,?,'2025-01-01','2025-01-01')`, row.id, nodeID, row.status, string(snapshots[row.id]), row.providerID, row.resultID, row.outputPath); err != nil {
			t.Fatal(err)
		}
	}
	if err := service.Close(); err != nil {
		t.Fatal(err)
	}
	service = New(settings)
	defer service.Close()
	p = recoverProject(t, service, dir)
	for range 5 {
		if err := p.advance(ctx, settings); err != nil {
			t.Fatal(err)
		}
	}
	if polls != 2 || downloads != 1 {
		t.Fatalf("known ID did not survive recovery and a temporary polling error: polls=%d downloads=%d", polls, downloads)
	}
	tasks := tasksIn(t, service, dir, "a")
	if len(tasks) != len(snapshots) {
		t.Fatalf("historical task list has %d records, want %d", len(tasks), len(snapshots))
	}
	for _, task := range tasks {
		switch task.ID {
		case "proofless", "violating":
			if task.Status != "failed" || task.Error != rebuildVideoInput || task.ProviderTaskID != "" {
				t.Fatalf("unverified task not held for rebuild: %+v", task)
			}
			if _, err := call(service, dir, "a", "resume_task", map[string]any{"operationId": "try-" + task.ID, "taskId": task.ID}); err == nil || !strings.Contains(err.Error(), "有上游 ID") {
				t.Fatalf("resume_task should require a provider ID for %s: %v", task.ID, err)
			}
		case "interrupted":
			if task.Status != "uncertain" || !strings.Contains(task.Error, "确认未提交后，从当前 Canvas 节点重新生成") {
				t.Fatalf("possibly submitted legacy task lost restart guidance: %+v", task)
			}
		case "history":
			if task.Status != "succeeded" || task.ResultNodeID != archivedID || task.OutputPath != historyPath {
				t.Fatalf("historical task was changed: %+v", task)
			}
		case knownID:
			if task.Status != "succeeded" || task.ProviderTaskID != "known-legacy-id" || task.ResultNodeID == "" || task.OutputPath == "" {
				t.Fatalf("known legacy task did not complete: %+v", task)
			}
		default:
			t.Fatalf("unexpected task: %+v", task)
		}
		if task.Status == "succeeded" {
			saved, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(task.OutputPath)))
			if err != nil || !bytes.Equal(saved, protocolTestVideo) {
				t.Fatalf("historical output is invalid: %s (%v)", task.OutputPath, err)
			}
		}
		_, stored, err := scanTask(p.db.QueryRow("SELECT "+taskColumns+" FROM tasks WHERE id=?", task.ID))
		if err != nil || stored != string(snapshots[task.ID]) {
			t.Fatalf("snapshot %s was rewritten: %s (%v)", task.ID, stored, err)
		}
	}
}

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
