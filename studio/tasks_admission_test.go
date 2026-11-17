package studio

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/png"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
)

const admissionFramePath = "assets/images/admission.png"

type videoAdmissionFixture struct {
	s        *Service
	p        *project
	settings *ProviderSettings
	dir      string
	draft    string
	source   string
	result   string
	other    string
}

func newVideoAdmissionFixture(t *testing.T) videoAdmissionFixture {
	t.Helper()
	settings := miniMaxInputFixture(t)
	settings.client.Transport = testTransport(func(*http.Request) (*http.Response, error) {
		t.Error("admission fixture called a provider")
		return nil, errors.New("unexpected HTTP request")
	})
	dir := t.TempDir()
	s := New(settings)
	t.Cleanup(func() { _ = s.Close() })
	bindSession(t, s, dir, "test")
	s.SetHumanWriteCheck(func(context.Context, string, string, []string) (bool, error) { return true, nil })
	p, err := s.open(context.Background(), dir, false)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, filepath.FromSlash(admissionFramePath))
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	err = png.Encode(file, image.NewRGBA(image.Rect(0, 0, 16, 9)))
	if err := errors.Join(err, file.Close()); err != nil {
		t.Fatal(err)
	}
	draft, source, result, other := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	_, err = editCall(s, dir, "test", "human", "append", appendArgs{operation: operation{ID: "create-drafts"},
		Nodes: []NodeInput{
			{ID: draft, Type: "video", Content: json.RawMessage(`{"mode":"i2v","prompt":"Move the picture."}`)},
			{ID: source, Type: "image", Content: json.RawMessage(`{"prompt":"Draw the picture."}`)},
			{ID: result, Type: "image", Content: json.RawMessage(fmt.Sprintf(`{"path":%q}`, admissionFramePath))},
			{ID: other, Type: "image", Content: json.RawMessage(`{"url":"https://example.test/other.png"}`)},
		}, Edges: []Edge{{Source: source, Target: draft}},
	})
	if err != nil {
		t.Fatal(err)
	}
	f := videoAdmissionFixture{s, p, settings, dir, draft, source, result, other}
	f.resultFor(t, result)
	return f
}

func (f videoAdmissionFixture) exec(t *testing.T, query string, args ...any) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	if _, err := f.p.db.ExecContext(ctx, query, args...); err != nil {
		t.Fatal(err)
	}
}

func (f videoAdmissionFixture) resultFor(t *testing.T, result string) {
	t.Helper()
	f.exec(t, `INSERT INTO tasks(id,node_id,session_id,type,status,input,result_node_id,created_at,updated_at)
		VALUES(?,?,'test','image','succeeded','{}',?,'','')`, uuid.NewString(), f.source, result)
}

func (f videoAdmissionFixture) start(ctx context.Context, action, opID, profile string) <-chan error {
	done := make(chan error, 1)
	go func() {
		args := map[string]any{"operationId": opID, "nodeId": f.draft}
		if action != "submit" {
			args["confirmed"] = true
		}
		if profile != "" {
			args["profileId"] = profile
		}
		data, err := json.Marshal(args)
		if err == nil {
			_, err = f.s.Execute(ctx, Request{
				SessionID: "test", WorkspaceID: "native-workspace", WorkspacePath: f.dir, Action: action, Data: data,
			})
		}
		done <- err
	}()
	return done
}

func waitForAdmission[T any](t *testing.T, ctx context.Context, ch <-chan T) T {
	t.Helper()
	select {
	case value := <-ch:
		return value
	case <-ctx.Done():
		t.Fatal("admission barrier timed out:", ctx.Err())
		var zero T
		return zero
	}
}

func (f videoAdmissionFixture) pauseHash(entered chan<- struct{}, release <-chan struct{}) {
	f.p.hashVideoMedia = func(ctx context.Context, file *os.File) (string, error) {
		entered <- struct{}{}
		select {
		case <-release:
			return localMediaSHA256(ctx, file)
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}
}

func TestVideoAdmissionSlowHashLetsReceiptCommit(t *testing.T) {
	f := newVideoAdmissionFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	const providerID = "receipt-before-other-hash"
	submitting, reply := make(chan struct{}), make(chan struct{})
	provider := providerFixture{submit: func(input GenerationInput) (ProviderSubmission, error) {
		close(submitting)
		select {
		case <-reply:
			return ProviderSubmission{TaskID: providerID}, nil
		case <-ctx.Done():
			return ProviderSubmission{}, ctx.Err()
		}
	}}
	first := queueLifecycleVideo(t, f.s, f.dir, "other-task")
	advance := make(chan error, 1)
	go func() { advance <- f.p.advance(ctx, provider) }()
	waitForAdmission(t, ctx, submitting)

	hashing, finishHash := make(chan struct{}, 1), make(chan struct{})
	f.pauseHash(hashing, finishHash)
	second := f.start(ctx, "generateI2V", "prepare-with-paused-hash", "")
	waitForAdmission(t, ctx, hashing)
	writer, err := os.OpenFile(filepath.Join(f.dir, admissionFramePath), os.O_WRONLY, 0)
	if err == nil {
		writer.Close()
		t.Fatal("stable admission handle allowed write sharing")
	}
	close(reply)
	if err := waitForAdmission(t, ctx, advance); err != nil {
		t.Fatal(err)
	}
	var savedID, state string
	if err := f.p.db.QueryRowContext(ctx, "SELECT provider_id,status FROM tasks WHERE node_id=?", first).
		Scan(&savedID, &state); err != nil || savedID != providerID || state != "polling" {
		t.Fatalf("receipt not durable while other hash was held: %q %q %v", savedID, state, err)
	}
	select {
	case err := <-second:
		t.Fatalf("second submission returned with its hash still blocked: %v", err)
	default:
	}
	close(finishHash)
	if err := waitForAdmission(t, ctx, second); err != nil {
		t.Fatal(err)
	}
	t.Log("first receipt was durable while the second task's SHA-256 was paused")
}

func TestVideoAdmissionRevalidatesOnlyActualDependencies(t *testing.T) {
	for _, tc := range []struct {
		name      string
		explicit  bool
		automatic bool
		wantCode  int
		prepare   func(*testing.T, videoAdmissionFixture)
		change    func(*testing.T, videoAdmissionFixture)
	}{
		{name: "target revision", wantCode: http.StatusConflict, change: func(t *testing.T, f videoAdmissionFixture) {
			f.exec(t, "UPDATE nodes SET revision=revision+1,content=json_set(content,'$.prompt','changed') WHERE id=?", f.draft)
		}},
		{name: "actual incoming edge", wantCode: http.StatusConflict, change: func(t *testing.T, f videoAdmissionFixture) {
			f.exec(t, "UPDATE edges SET source=? WHERE source=? AND target=?", f.other, f.source, f.draft)
		}},
		{name: "effective media order", wantCode: http.StatusConflict, prepare: func(t *testing.T, f videoAdmissionFixture) {
			f.exec(t, "INSERT INTO edges(source,target) VALUES(?,?)", f.other, f.draft)
		}, change: func(t *testing.T, f videoAdmissionFixture) {
			f.exec(t, "UPDATE nodes SET content=json_set(content,'$.mixedListOrder',json_array(?,?)) WHERE id=?", f.other, f.source, f.draft)
		}},
		{name: "source revision", wantCode: http.StatusConflict, change: func(t *testing.T, f videoAdmissionFixture) {
			f.exec(t, "UPDATE nodes SET revision=revision+1 WHERE id=?", f.source)
		}},
		{name: "actual selected result", wantCode: http.StatusConflict, change: func(t *testing.T, f videoAdmissionFixture) {
			f.resultFor(t, f.other)
		}},
		{name: "same result new revision", wantCode: http.StatusConflict, change: func(t *testing.T, f videoAdmissionFixture) {
			f.exec(t, "UPDATE nodes SET revision=revision+1 WHERE id=?", f.result)
		}},
		{name: "explicit profile parameters", explicit: true, wantCode: http.StatusConflict, change: func(_ *testing.T, f videoAdmissionFixture) {
			f.settings.mu.Lock()
			defer f.settings.mu.Unlock()
			f.settings.data.Profiles[0].Defaults.Duration = 5
		}},
		{name: "implicit default profile", wantCode: http.StatusConflict, change: func(_ *testing.T, f videoAdmissionFixture) {
			f.settings.mu.Lock()
			defer f.settings.mu.Unlock()
			next := f.settings.data.Profiles[0]
			next.ID = uuid.NewString()
			f.settings.data.Profiles = append(f.settings.data.Profiles, next)
			f.settings.data.Generation.DefaultModelID = next.ID
		}},
		{name: "same profile credential replaced", wantCode: http.StatusConflict, change: func(_ *testing.T, f videoAdmissionFixture) {
			f.settings.mu.Lock()
			defer f.settings.mu.Unlock()
			f.settings.data.Keys["h3"] = "test-rotated-credential"
		}},
		{name: "automatic permission revoked", automatic: true, wantCode: http.StatusForbidden, change: func(t *testing.T, f videoAdmissionFixture) {
			mustCall(t, f.s, f.dir, "test", "permission", map[string]any{"operationId": "permission-revoke", "enabled": false})
		}},
		{name: "unrelated node", change: func(t *testing.T, f videoAdmissionFixture) {
			mustCall(t, f.s, f.dir, "test", "append", appendArgs{operation: operation{ID: "edit-unrelated"},
				Nodes: []NodeInput{{Type: "note", Content: json.RawMessage(`{"text":"this moves the workspace event sequence"}`)}},
			})
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newVideoAdmissionFixture(t)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			action, profileID := "generateI2V", ""
			if tc.automatic {
				mustCall(t, f.s, f.dir, "test", "permission", map[string]any{"operationId": "permission-grant", "enabled": true})
				action = "submit"
			}
			if tc.explicit {
				profileID = f.settings.data.Profiles[0].ID
			}
			if tc.prepare != nil {
				tc.prepare(t, f)
			}
			hashing, finish := make(chan struct{}, 1), make(chan struct{})
			f.pauseHash(hashing, finish)
			done := f.start(ctx, action, "submit-while-changing", profileID)
			waitForAdmission(t, ctx, hashing)
			tc.change(t, f)
			close(finish)
			err := waitForAdmission(t, ctx, done)
			var status *requestError
			if tc.wantCode == 0 {
				if err != nil {
					t.Fatal(err)
				}
				var stored string
				if err := f.p.db.QueryRowContext(ctx, "SELECT input FROM tasks WHERE node_id=?", f.draft).Scan(&stored); err != nil {
					t.Fatal(err)
				}
				var request generationRequest
				if err := json.Unmarshal([]byte(stored), &request); err != nil || request.VideoInputContract != videoInputContractVersion ||
					request.Prompt != "Move the picture." || len(request.References) != 1 || request.References[0].LocalSHA256 == "" ||
					request.References[0].ResultNodeID != f.result || request.References[0].Role != "first_frame" {
					t.Fatalf("unexpected frozen task %+v, %v", request, err)
				}
			} else {
				if !errors.As(err, &status) || status.code != tc.wantCode {
					t.Fatalf("want status %d, got %v", tc.wantCode, err)
				}
				var count int
				if err := f.p.db.QueryRowContext(ctx, "SELECT count(*) FROM tasks WHERE node_id=?", f.draft).Scan(&count); err != nil || count != 0 {
					t.Fatalf("stale admission created %d tasks (%v)", count, err)
				}
			}
		})
	}
}

func TestVideoAdmissionCoalescesOperationReplayAndRejectsOversizeBeforeHash(t *testing.T) {
	t.Run("concurrent operation replay", func(t *testing.T) {
		f := newVideoAdmissionFixture(t)
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		hashing, finish := make(chan struct{}, 3), make(chan struct{})
		f.pauseHash(hashing, finish)
		first := f.start(ctx, "generateI2V", "same-operation", "")
		second := f.start(ctx, "generateI2V", "same-operation", "")
		waitForAdmission(t, ctx, hashing)
		waitForAdmission(t, ctx, hashing)
		close(finish)
		for _, done := range []<-chan error{first, second} {
			if err := waitForAdmission(t, ctx, done); err != nil {
				t.Fatal(err)
			}
		}
		if err := waitForAdmission(t, ctx, f.start(ctx, "generateI2V", "same-operation", "")); err != nil {
			t.Fatal(err)
		}
		var count int
		if err := f.p.db.QueryRowContext(ctx, "SELECT count(*) FROM tasks WHERE node_id=?", f.draft).Scan(&count); err != nil || count != 1 || len(hashing) != 0 {
			t.Fatalf("replay: tasks=%d, extra hashes=%d, error=%v", count, len(hashing), err)
		}
	})
	t.Run("channel cap checked before any hash", func(t *testing.T) {
		const tailPath = "assets/images/oversize.png"
		f := newVideoAdmissionFixture(t)
		file, err := os.Create(filepath.Join(f.dir, tailPath))
		if err != nil {
			t.Fatal(err)
		}
		err = file.Truncate(minimaxFileLimits["image"] + 1)
		if err := errors.Join(err, file.Close()); err != nil {
			t.Fatal(err)
		}
		if _, err := f.p.db.Exec("UPDATE nodes SET content=json_object('path',?) WHERE id=?", tailPath, f.other); err != nil {
			t.Fatal(err)
		}
		f.exec(t, "INSERT INTO edges(source,target) VALUES(?,?)", f.other, f.draft)
		var hashes atomic.Int32
		f.p.hashVideoMedia = func(context.Context, *os.File) (string, error) {
			hashes.Add(1)
			return "", errors.New("oversized admission reached hash")
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		err = waitForAdmission(t, ctx, f.start(ctx, "generateI2V", "reject-oversized-tail", ""))
		if err == nil || !strings.Contains(err.Error(), "大小限制") || hashes.Load() != 0 {
			t.Fatalf("oversized tail: hashes=%d, error=%v", hashes.Load(), err)
		}
	})
}
