package studio

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
)

type lifecycleFixture struct {
	limit        int
	gate         <-chan struct{}
	submitGate   <-chan struct{}
	downloadGate <-chan struct{}
	result       ProviderResult
	pollError    error
	ready        atomic.Bool
	submits      atomic.Int32
	polls        atomic.Int32
	downloads    atomic.Int32
	submitted    chan string
	downloading  chan struct{}
}

func (f *lifecycleFixture) MaxConcurrent() int { return f.limit }

func (f *lifecycleFixture) Prepare(input *GenerationInput, _ string) error {
	input.OutputDirectory = "assets/test-renders"
	return nil
}

func (f *lifecycleFixture) Resolve(ProviderProfile) (Provider, error) { return f, nil }

func (f *lifecycleFixture) Submit(ctx context.Context, input GenerationInput) (ProviderSubmission, error) {
	f.submits.Add(1)
	id := "provider-" + input.Prompt
	if f.submitted != nil {
		select {
		case f.submitted <- id:
		case <-ctx.Done():
			return ProviderSubmission{}, ctx.Err()
		}
	}
	if f.submitGate != nil {
		select {
		case <-f.submitGate:
		case <-ctx.Done():
			return ProviderSubmission{}, ctx.Err()
		}
	}
	return ProviderSubmission{TaskID: id}, nil
}

func (f *lifecycleFixture) Poll(ctx context.Context, _ string) (ProviderResult, error) {
	f.polls.Add(1)
	if f.result.Status != "" || f.pollError != nil {
		return f.result, f.pollError
	}
	if f.gate != nil {
		select {
		case <-f.gate:
		case <-ctx.Done():
			return ProviderResult{}, ctx.Err()
		}
	} else if !f.ready.Load() {
		return ProviderResult{Status: "running"}, nil
	}
	return ProviderResult{Status: "succeeded", Extension: ".mp4"}, nil
}

func (f *lifecycleFixture) Download(ctx context.Context, _ ProviderResult, writer io.Writer) error {
	f.downloads.Add(1)
	if f.downloading != nil {
		select {
		case f.downloading <- struct{}{}:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	if f.downloadGate != nil {
		select {
		case <-f.downloadGate:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	_, err := writer.Write(protocolTestVideo)
	return err
}

func queueLifecycleVideo(t *testing.T, service *Service, dir, label string) string {
	t.Helper()
	nodeID := uuid.NewString()
	content, err := json.Marshal(map[string]string{"prompt": label, "mode": "t2v"})
	if err != nil {
		t.Fatal(err)
	}
	mustCall(t, service, dir, "test", "append", appendArgs{operation: operation{ID: "append-" + label}, Nodes: []NodeInput{
		{ID: nodeID, Type: "video", Content: content},
	}})
	mustCall(t, service, dir, "test", "submit_manual", map[string]any{
		"operationId": "submit-" + label, "nodeId": nodeID, "confirmed": true,
	})
	return nodeID
}

func startLifecycleWorker(t *testing.T, service *Service) func() {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		service.Run(ctx)
	}()
	stop := sync.OnceFunc(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("worker did not stop after cancellation")
		}
		if err := service.Close(); err != nil {
			t.Errorf("close worker test service: %v", err)
		}
	})
	t.Cleanup(stop)
	return stop
}

func waitLifecycleTasks(t *testing.T, service *Service, dir string, want int, status string) []Task {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		response, err := service.Execute(ctx, Request{
			SessionID: "test", WorkspaceID: "native-workspace", WorkspacePath: dir, Action: "tasks",
		})
		if err != nil {
			t.Fatalf("reading tasks while waiting for %s: %v", status, err)
		}
		tasks := response.(map[string][]Task)["tasks"]
		allMatch := len(tasks) == want
		for _, task := range tasks {
			allMatch = allMatch && task.Status == status
		}
		if allMatch {
			return tasks
		}
		select {
		case <-ctx.Done():
			t.Fatalf("waiting for %d %s tasks: %+v", want, status, tasks)
		case <-ticker.C:
		}
	}
}

func TestVideoWorkerGlobalConcurrency(t *testing.T) {
	for _, limit := range []int{1, 2} {
		t.Run(fmt.Sprintf("limit-%d", limit), func(t *testing.T) {
			release := make(chan struct{})
			fixture := &lifecycleFixture{limit: limit, gate: release, submitted: make(chan string, 3)}
			service := New(fixture)
			service.pollInterval, service.pollTimeout = 10*time.Millisecond, 3*time.Second
			first, second := t.TempDir(), t.TempDir()
			bindSession(t, service, first, "test")
			bindSession(t, service, second, "test")
			queueLifecycleVideo(t, service, first, "first")
			queueLifecycleVideo(t, service, second, "second")
			startLifecycleWorker(t, service)

			for range limit {
				select {
				case <-fixture.submitted:
				case <-time.After(5 * time.Second):
					t.Fatalf("worker did not start %d simultaneous remote jobs", limit)
				}
			}
			queueLifecycleVideo(t, service, second, "third")
			select {
			case id := <-fixture.submitted:
				t.Fatalf("global cap %d exceeded by %s while existing jobs remained active", limit, id)
			case <-time.After(100 * time.Millisecond):
			}
			close(release)
			waitLifecycleTasks(t, service, first, 1, "succeeded")
			waitLifecycleTasks(t, service, second, 2, "succeeded")
			if submitted := fixture.submits.Load(); submitted != 3 {
				t.Fatalf("submitted %d jobs, want exactly 3", submitted)
			}
		})
	}
}

func TestVideoWorkerResumesPausedTaskAfterRestart(t *testing.T) {
	fixture := &lifecycleFixture{limit: 2}
	dir := t.TempDir()
	service := New(fixture)
	service.pollInterval, service.pollTimeout = 10*time.Millisecond, 70*time.Millisecond
	bindSession(t, service, dir, "test")
	queueLifecycleVideo(t, service, dir, "resume")
	stop := startLifecycleWorker(t, service)
	paused := waitLifecycleTasks(t, service, dir, 1, "paused")[0]
	if paused.ProviderTaskID != "provider-resume" || paused.Error == "" || paused.OutputPath != "" || fixture.polls.Load() == 0 {
		t.Fatalf("timeout lost the task, provider ID or explanation: %+v", paused)
	}
	pollsAtPause := fixture.polls.Load()
	time.Sleep(50 * time.Millisecond)
	if fixture.polls.Load() != pollsAtPause {
		t.Fatal("paused task continued polling")
	}
	stop()

	fixture.ready.Store(true)
	service = New(fixture)
	service.pollInterval, service.pollTimeout = 10*time.Millisecond, 3*time.Second
	recoverProject(t, service, dir)
	startLifecycleWorker(t, service)
	finished := waitLifecycleTasks(t, service, dir, 1, "succeeded")[0]
	if finished.ID != paused.ID || finished.ProviderTaskID != paused.ProviderTaskID || fixture.submits.Load() != 1 {
		t.Fatalf("recovered task was replaced or resubmitted: before=%+v after=%+v submits=%d", paused, finished, fixture.submits.Load())
	}
	wantPath := "assets/test-renders/" + finished.ID + ".mp4"
	if finished.OutputPath != wantPath || finished.ResultNodeID == "" || finished.CompletedAt == "" {
		t.Fatalf("completed task did not persist its asset or completion time: %+v", finished)
	}
	output, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(finished.OutputPath)))
	if err != nil || !bytes.Equal(output, protocolTestVideo) {
		t.Fatalf("invalid recovered output, bytes=%d err=%v", len(output), err)
	}
	encoded, err := json.Marshal(finished)
	if err != nil || !strings.Contains(string(encoded), `"status":"completed"`) {
		t.Fatalf("unexpected public task state: %s %v", encoded, err)
	}
}

func TestVideoWorkerStopsAtProviderFailure(t *testing.T) {
	for _, test := range []struct {
		name, reason string
		result       ProviderResult
		err          error
	}{
		{name: "terminal response", reason: "vendor processing failed",
			result: ProviderResult{Status: "failed", Error: "vendor processing failed"}},
		{name: "permanent HTTP error", reason: "task unavailable",
			err: (videoHTTP{}).responseError(404, "task unavailable")},
	} {
		t.Run(test.name, func(t *testing.T) {
			fixture := &lifecycleFixture{limit: 2, result: test.result, pollError: test.err}
			dir := t.TempDir()
			service := New(fixture)
			service.pollInterval, service.pollTimeout = 10*time.Millisecond, 3*time.Second
			bindSession(t, service, dir, "test")
			queueLifecycleVideo(t, service, dir, "provider-failure")
			startLifecycleWorker(t, service)
			failed := waitLifecycleTasks(t, service, dir, 1, "failed")[0]
			if !strings.Contains(failed.Error, test.reason) || failed.ProviderTaskID == "" || failed.CompletedAt == "" || failed.OutputPath != "" {
				t.Fatalf("incomplete failure record: %+v", failed)
			}
			time.Sleep(50 * time.Millisecond)
			if got := fixture.polls.Load(); got != 1 {
				t.Fatalf("terminal failure was polled %d times", got)
			}
		})
	}
}

func TestVideoWorkerKeepsTaskOwnershipAcrossServices(t *testing.T) {
	releaseSubmit, releaseDownload := make(chan struct{}), make(chan struct{})
	first := &lifecycleFixture{limit: 1, submitGate: releaseSubmit, downloadGate: releaseDownload,
		submitted: make(chan string, 1), downloading: make(chan struct{}, 1)}
	second := &lifecycleFixture{limit: 1, submitted: make(chan string, 2)}
	first.ready.Store(true)
	second.ready.Store(true)

	dir := t.TempDir()
	firstService := New(first)
	firstService.pollInterval = 10 * time.Millisecond
	bindSession(t, firstService, dir, "test")
	nodeID := queueLifecycleVideo(t, firstService, dir, "shared")
	startLifecycleWorker(t, firstService)
	waitLifecycleSubmission(t, first.submitted, "provider-shared")

	secondService := New(second)
	secondService.pollInterval = 10 * time.Millisecond
	recoverProject(t, secondService, dir)
	startLifecycleWorker(t, secondService)
	queueLifecycleVideo(t, secondService, dir, "during-submit")
	waitLifecycleSubmission(t, second.submitted, "provider-during-submit")
	shared := lifecycleTaskForNode(t, secondService, dir, nodeID)
	if shared.Status != "submitting" || shared.ProviderTaskID != "" {
		t.Fatalf("second worker changed the live submission: %+v", shared)
	}

	close(releaseSubmit)
	select {
	case <-first.downloading:
	case <-time.After(5 * time.Second):
		t.Fatal("owning worker did not persist its receipt and reach download")
	}
	queueLifecycleVideo(t, secondService, dir, "during-download")
	waitLifecycleSubmission(t, second.submitted, "provider-during-download")
	shared = lifecycleTaskForNode(t, secondService, dir, nodeID)
	if shared.Status != "polling" || shared.ProviderTaskID != "provider-shared" {
		t.Fatalf("second worker changed the active download task: %+v", shared)
	}
	close(releaseDownload)
	waitLifecycleTasks(t, secondService, dir, 3, "succeeded")
	shared = lifecycleTaskForNode(t, secondService, dir, nodeID)
	if shared.ProviderTaskID != "provider-shared" || shared.ResultNodeID == "" ||
		first.submits.Load() != 1 || first.downloads.Load() != 1 ||
		second.submits.Load() != 2 || second.downloads.Load() != 2 {
		t.Fatalf("unexpected shared task or worker calls: task=%+v submits=%d/%d downloads=%d/%d",
			shared, first.submits.Load(), second.submits.Load(), first.downloads.Load(), second.downloads.Load())
	}
}

func waitLifecycleSubmission(t *testing.T, submitted <-chan string, want string) {
	t.Helper()
	select {
	case got := <-submitted:
		if got != want {
			t.Fatalf("submitted %q, want %q", got, want)
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("did not submit %q", want)
	}
}

func lifecycleTaskForNode(t *testing.T, service *Service, dir, nodeID string) Task {
	t.Helper()
	for _, task := range tasksIn(t, service, dir, "test") {
		if task.NodeID == nodeID {
			return task
		}
	}
	t.Fatalf("missing task for node %s", nodeID)
	return Task{}
}
