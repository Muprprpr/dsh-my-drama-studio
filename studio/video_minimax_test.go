package studio

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"image"
	"image/png"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestMiniMaxH3Transport(t *testing.T) {
	const (
		key      = "fixture-credential"
		taskID   = "4191234567891234"
		output   = "https://cdn.example.test/finished.mp4?signature=fixture"
		video    = "\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom"
		prompt   = "相机缓慢推进。保留完整提示词、对白和声音描述。"
		tailURL  = "https://assets.example.test/tail.png"
		refVideo = "https://assets.example.test/clip.mp4"
		refAudio = "https://assets.example.test/ambient.wav"
	)
	workspace := t.TempDir()
	var firstFrame bytes.Buffer
	if err := png.Encode(&firstFrame, image.NewRGBA(image.Rect(0, 0, 256, 256))); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(workspace, "assets", "images"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "assets", "images", "first.png"), firstFrame.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"t2v", "i2v", "r2v"} {
		t.Run(mode, func(t *testing.T) {
			input := GenerationInput{Type: "video", Mode: mode, Prompt: prompt, WorkspacePath: workspace,
				Params: VideoParams{Duration: 4, Resolution: "768p", AspectRatio: "16:9"}}
			wantContent := []any{map[string]any{"type": "text", "text": prompt}}
			if mode != "t2v" {
				input.References = []GenerationReference{{Type: "image", Path: "assets/images/first.png"}}
				role := "first_frame"
				if mode == "r2v" {
					role = "reference_image"
				}
				wantContent = append(wantContent, minimaxFixtureContent("image", role, "mm_file://12345"))
			}
			if mode == "i2v" {
				input.References = append(input.References, GenerationReference{Type: "image", URL: tailURL})
				wantContent = append(wantContent, minimaxFixtureContent("image", "last_frame", tailURL))
			}
			if mode == "r2v" {
				input.References = append(input.References, GenerationReference{Type: "video", URL: refVideo}, GenerationReference{Type: "audio", URL: refAudio})
				wantContent = append(wantContent, minimaxFixtureContent("video", "reference_video", refVideo), minimaxFixtureContent("audio", "reference_audio", refAudio))
			}
			wantBody := map[string]any{"model": minimaxH3Model, "content": wantContent, "resolution": "768P", "duration": float64(4)}
			if mode != "i2v" {
				wantBody["ratio"] = "16:9"
			}
			polls, uploads := 0, 0
			client := &http.Client{Transport: arkFixtureTransport(func(req *http.Request) (*http.Response, error) {
				if req.URL.String() == output {
					if req.Method != http.MethodGet || req.Header.Get("Authorization") != "" {
						t.Fatal("download must use no credential")
					}
					return arkFixtureResponse(http.StatusOK, video)
				}
				if req.URL.Scheme != "https" || req.URL.Host != "metaso.cn" || req.Header.Get("Authorization") != "Bearer "+key {
					t.Fatalf("unexpected H3 endpoint or credentials: %s %s", req.Method, req.URL.Path)
				}
				switch req.Method + " " + req.URL.Path {
				case "GET /api/minimax" + minimaxH3Balance:
					return arkFixtureResponse(http.StatusOK, `{"balance":0}`)
				case "POST /api/minimax" + minimaxH3Upload:
					uploads++
					minimaxVerifyUpload(t, req, firstFrame.Bytes())
					return arkFixtureResponse(http.StatusOK, `{"file":{"file_id":12345},"base_resp":{"status_code":0}}`)
				case "POST /api/minimax" + minimaxH3Submit:
					var got map[string]any
					if req.Header.Get("Content-Type") != "application/json" || json.NewDecoder(req.Body).Decode(&got) != nil {
						t.Fatal("expected a JSON request")
					}
					if !reflect.DeepEqual(got, wantBody) {
						t.Fatalf("submit body = %#v, want %#v", got, wantBody)
					}
					return arkFixtureResponse(http.StatusOK, `{"task_id":"`+taskID+`"}`)
				case "GET /api/minimax" + minimaxH3Query + taskID:
					polls++
					status := []string{"queued", "running", "succeeded"}[polls-1]
					return arkFixtureResponse(http.StatusOK, `{"task":{"id":"`+taskID+`","status":"`+status+`","content":{"url":"`+output+`"}}}`)
				default:
					t.Fatalf("unexpected H3 request: %s %s", req.Method, req.URL.Path)
					return nil, errors.New("unexpected request")
				}
			})}
			profile := ProviderProfile{Model: minimaxH3Model, Mode: mode, Limits: VideoLimits{LastFrame: true},
				Channel: &VideoChannel{BaseURL: "https://other.example.test"}}
			provider := newMinimaxProvider(profile, key, client).(*minimaxProvider)
			ctx := context.Background()
			if err := provider.Verify(ctx); err != nil {
				t.Fatal(err)
			}
			submitted, err := provider.Submit(ctx, input)
			if err != nil || submitted.TaskID != taskID || submitted.Rejected {
				t.Fatalf("submit = %+v, %v", submitted, err)
			}
			var result ProviderResult
			for _, status := range []string{"pending", "running", "succeeded"} {
				result, err = provider.Poll(ctx, taskID)
				if err != nil || result.Status != status {
					t.Fatalf("poll = %+v, %v, want %s", result, err, status)
				}
			}
			var artifact bytes.Buffer
			if err := provider.Download(ctx, result, &artifact); err != nil || artifact.String() != video || result.Extension != ".mp4" {
				t.Fatalf("download = %q, extension = %q, err = %v", artifact.String(), result.Extension, err)
			}
			if uploads != map[string]int{"t2v": 0, "i2v": 1, "r2v": 1}[mode] {
				t.Fatalf("unexpected upload count %d", uploads)
			}
		})
	}
}

func minimaxFixtureContent(kind, role, source string) map[string]any {
	field := kind + "_url"
	return map[string]any{"type": field, "role": role, field: map[string]any{"url": source}}
}

func minimaxVerifyUpload(t *testing.T, req *http.Request, expected []byte) {
	t.Helper()
	contentType, params, err := mime.ParseMediaType(req.Header.Get("Content-Type"))
	if err != nil || contentType != "multipart/form-data" {
		t.Fatalf("invalid multipart type %q: %v", contentType, err)
	}
	body, err := io.ReadAll(req.Body)
	if err != nil || req.ContentLength != int64(len(body)) {
		t.Fatalf("incorrect upload size %d, read %d, %v", req.ContentLength, len(body), err)
	}
	reader := multipart.NewReader(bytes.NewReader(body), params["boundary"])
	purpose, err := reader.NextPart()
	if err != nil || purpose.FormName() != "purpose" {
		t.Fatalf("upload lacks purpose: %v", err)
	}
	if value, err := io.ReadAll(purpose); err != nil || string(value) != "video_generation_input" {
		t.Fatalf("upload purpose = %q, %v", value, err)
	}
	file, err := reader.NextPart()
	if err != nil || file.FormName() != "file" || file.FileName() != "reference.png" {
		t.Fatalf("upload has wrong file metadata: %v", err)
	}
	if actual, err := io.ReadAll(file); err != nil || !bytes.Equal(actual, expected) {
		t.Fatalf("upload media mismatch: %v", err)
	}
	if _, err := reader.NextPart(); !errors.Is(err, io.EOF) {
		t.Fatalf("upload has unexpected trailing part: %v", err)
	}
}

func TestMiniMaxH3RejectionAndPermanentPollErrors(t *testing.T) {
	const key = "fixture-credential"
	for _, fixture := range []struct {
		name     string
		body     string
		code     int
		rejected bool
	}{
		{"quota", `{"error":{"message":"insufficient balance for fixture-credential"}}`, 402, true},
		{"service rejection", `{"base_resp":{"status_code":1004,"status_msg":"invalid token fixture-credential"}}`, 200, true},
		{"missing ID", `{"status":"accepted"}`, 200, false},
		{"upstream timeout", `{"error":{"message":"timeout"}}`, 504, false},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			client := &http.Client{Transport: arkFixtureTransport(func(req *http.Request) (*http.Response, error) {
				if req.Method != http.MethodPost || req.URL.Path != "/api/minimax"+minimaxH3Submit {
					t.Fatalf("unexpected call: %s %s", req.Method, req.URL.Path)
				}
				return arkFixtureResponse(fixture.code, fixture.body)
			})}
			provider := newMinimaxProvider(ProviderProfile{Model: minimaxH3Model, Mode: "t2v"}, key, client)
			result, err := provider.Submit(context.Background(), GenerationInput{Type: "video", Mode: "t2v", Prompt: "A moving shape"})
			if err == nil || result.Rejected != fixture.rejected || result.TaskID != "" || strings.Contains(err.Error(), key) {
				t.Fatalf("submit = %+v, %v", result, err)
			}
		})
	}
	for _, fixture := range []struct {
		status     string
		body       string
		wantStatus string
		permanent  bool
	}{
		{"success without output", `{"task":{"id":"task-1","status":"succeeded"}}`, "", true},
		{"wrong ID", `{"task":{"id":"task-2","status":"running"}}`, "", true},
		{"cancelled", `{"task":{"id":"task-1","status":"cancelled"}}`, "cancelled", false},
		{"failed", `{"task":{"id":"task-1","status":"failed","error":{"message":"denied fixture-credential https://example.test/signed?secret=x"}}}`, "failed", false},
	} {
		t.Run(fixture.status, func(t *testing.T) {
			client := &http.Client{Transport: arkFixtureTransport(func(*http.Request) (*http.Response, error) {
				return arkFixtureResponse(http.StatusOK, fixture.body)
			})}
			provider := newMinimaxProvider(ProviderProfile{Model: minimaxH3Model}, key, client)
			result, err := provider.Poll(context.Background(), "task-1")
			var classified interface{ Permanent() bool }
			if permanent := errors.As(err, &classified) && classified.Permanent(); permanent != fixture.permanent || result.Status != fixture.wantStatus {
				t.Fatalf("poll = %+v, %v", result, err)
			}
			if fixture.wantStatus == "failed" && result.Error != "denied [redacted] [URL]" {
				t.Fatalf("failed task returned an unredacted error: %q", result.Error)
			}
		})
	}
}

func TestMiniMaxH3RejectsUnsupportedModeAndParams(t *testing.T) {
	client := &http.Client{Transport: arkFixtureTransport(func(*http.Request) (*http.Response, error) {
		t.Fatal("invalid input reached the API")
		return nil, errors.New("unexpected API call")
	})}
	provider := newMinimaxProvider(ProviderProfile{Model: minimaxH3Model}, "fixture-credential", client)
	generateAudio := false
	for _, fixture := range []struct {
		name string
		mode string
		p    VideoParams
	}{
		{"V2V", "v2v", VideoParams{}},
		{"audio switch", "t2v", VideoParams{GenerateAudio: &generateAudio}},
		{"auto ratio for T2V", "t2v", VideoParams{AspectRatio: "adaptive"}},
		{"duration out of range", "t2v", VideoParams{Duration: 16}},
		{"unsupported resolution", "t2v", VideoParams{Resolution: "4K"}},
		{"missing first frame", "i2v", VideoParams{}},
		{"missing references", "r2v", VideoParams{}},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			result, err := provider.Submit(context.Background(), GenerationInput{Type: "video", Mode: fixture.mode, Prompt: "A moving shape", Params: fixture.p})
			if err == nil || !result.Rejected {
				t.Fatalf("invalid input not rejected: %+v, %v", result, err)
			}
		})
	}
}
