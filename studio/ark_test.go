package studio

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

type arkFixtureTransport func(*http.Request) (*http.Response, error)

func (f arkFixtureTransport) RoundTrip(req *http.Request) (*http.Response, error) { return f(req) }

func arkFixtureResponse(code int, body string) (*http.Response, error) {
	recorder := httptest.NewRecorder()
	recorder.Header().Set("Content-Type", "application/json")
	recorder.WriteHeader(code)
	_, _ = io.WriteString(recorder, body)
	return recorder.Result(), nil
}

func TestArkCreatePollDownloadAndVerify(t *testing.T) {
	ctx := context.Background()
	regions := []struct{ provider, model, host string }{
		{"ark", "doubao-seedance-2-5-260628", "ark.cn-beijing.volces.com"},
		{"byteplus", "dreamina-seedance-2-5-260628", "ark.ap-southeast.bytepluses.com"},
	}
	for _, region := range regions {
		for _, mode := range []string{"t2v", "i2v", "r2v"} {
			t.Run(region.provider+"/"+mode, func(t *testing.T) {
				const prompt = "风吹过森林。保留完整提示词与声音描述。"
				const outputURL = "https://ark-content-generation.tos-cn-beijing.volces.com/out.mov?signature=fixture"
				const id = "cgt-fixture-01"
				profile := ProviderProfile{
					Provider: region.provider, Mode: mode, Model: region.model, Duration: 5,
					Options: map[string]any{"watermark": false, "resolution": "720p", "generate_audio": true},
				}
				if mode != "i2v" {
					profile.AspectRatio = "16:9"
				}
				input := GenerationInput{Type: "video", Mode: mode, Prompt: prompt}
				wantContent := []any{map[string]any{"type": "text", "text": prompt}}
				for i := 0; i < map[string]int{"t2v": 0, "i2v": 1, "r2v": 2}[mode]; i++ {
					source := fmt.Sprintf("https://assets.example.test/ref-%d.png", i)
					input.References = append(input.References, GenerationReference{Type: "image", URL: source})
					role := "reference_image"
					if mode == "i2v" {
						role = "first_frame"
					}
					wantContent = append(wantContent, map[string]any{
						"type": "image_url", "role": role, "image_url": map[string]any{"url": source},
					})
				}

				polls := 0
				calls := 0
				client := &http.Client{Transport: arkFixtureTransport(func(req *http.Request) (*http.Response, error) {
					calls++
					if req.URL.String() == outputURL {
						if req.Method != http.MethodGet || req.Header.Get("Authorization") != "" {
							t.Fatalf("download request forwarded a provider credential: %s", req.Method)
						}
						return arkFixtureResponse(200, "video-bytes")
					}
					if req.URL.Scheme != "https" || req.URL.Host != region.host || req.Header.Get("Authorization") != "Bearer fixture-key" {
						t.Fatalf("unexpected Ark request: %s %s", req.Method, req.URL)
					}
					switch {
					case req.Method == http.MethodGet && req.URL.Path == arkTasksPath:
						if req.URL.Query().Get("page_num") != "1" || req.URL.Query().Get("page_size") != "1" || req.Body != nil {
							t.Fatal("connection check must only read one page from the task listing")
						}
						return arkFixtureResponse(200, "{\"total\":0,\"items\":[]}")
					case req.Method == http.MethodPost && req.URL.Path == arkTasksPath:
						if req.Header.Get("Content-Type") != "application/json" {
							t.Fatal("missing JSON request content type")
						}
						var body map[string]any
						if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
							t.Fatal(err)
						}
						want := map[string]any{
							"model": region.model, "content": wantContent, "duration": float64(5),
							"watermark": false, "resolution": "720p", "generate_audio": true,
						}
						if mode != "i2v" {
							want["ratio"] = "16:9"
						}
						if mode == "r2v" {
							want["omni_reference_task_type"] = "reference"
						}
						if !reflect.DeepEqual(body, want) {
							t.Fatalf("unexpected payload\n got: %#v\nwant: %#v", body, want)
						}
						return arkFixtureResponse(200, "{\"id\":\""+id+"\"}")
					case req.Method == http.MethodGet && req.URL.Path == arkTasksPath+"/"+id:
						polls++
						if polls == 1 {
							return arkFixtureResponse(200, "{\"id\":\""+id+"\",\"status\":\"queued\"}")
						}
						if polls == 2 {
							return arkFixtureResponse(200, "{\"id\":\""+id+"\",\"status\":\"running\"}")
						}
						return arkFixtureResponse(200, "{\"id\":\""+id+"\",\"status\":\"succeeded\",\"output_format\":\"mov\",\"content\":{\"video_url\":\""+outputURL+"\"}}")
					default:
						t.Fatalf("unexpected method or path: %s %s", req.Method, req.URL)
						return nil, errors.New("unexpected request")
					}
				})}
				provider := newArkProvider(profile, "fixture-key", client).(*arkProvider)
				if err := provider.Verify(ctx); err != nil {
					t.Fatal(err)
				}
				task, err := provider.Submit(ctx, input)
				if err != nil || task.TaskID != id || task.Rejected {
					t.Fatalf("submit = %+v, %v", task, err)
				}
				for _, status := range []string{"pending", "running"} {
					result, err := provider.Poll(ctx, id)
					if err != nil || result.Status != status {
						t.Fatalf("poll = %+v, %v, want %s", result, err, status)
					}
				}
				result, err := provider.Poll(ctx, id)
				if err != nil || result.Status != "succeeded" || result.URL != outputURL || result.Extension != ".mov" {
					t.Fatalf("poll = %+v, %v", result, err)
				}
				var video bytes.Buffer
				if err := provider.Download(ctx, result, &video); err != nil || video.String() != "video-bytes" {
					t.Fatalf("download = %q, %v", video.String(), err)
				}
				if calls != 6 {
					t.Fatalf("expected verify, submit, three polls and download, got %d calls", calls)
				}
			})
		}
	}
}

func TestArkLocalImageUsesDocumentedDataURI(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "assets", "images"), 0700); err != nil {
		t.Fatal(err)
	}
	var original bytes.Buffer
	if err := png.Encode(&original, image.NewRGBA(image.Rect(0, 0, 320, 320))); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "assets", "images", "frame.png"), original.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	provider := newArkProvider(ProviderProfile{Provider: "ark", Mode: "i2v", Model: "doubao-seedance-2-0-260128"}, "fixture", nil).(*arkProvider)
	input := GenerationInput{
		Type: "video", Mode: "i2v", Prompt: "镜头推进", WorkspacePath: dir,
		References: []GenerationReference{{Type: "image", Path: "assets/images/frame.png"}},
	}
	if err := provider.Validate(input); err != nil {
		t.Fatal(err)
	}
	payload, err := provider.payload(input)
	if err != nil {
		t.Fatal(err)
	}
	var data struct {
		Content []struct {
			Role  string `json:"role"`
			Image struct {
				URL string `json:"url"`
			} `json:"image_url"`
		} `json:"content"`
	}
	if err := json.Unmarshal(payload, &data); err != nil {
		t.Fatal(err)
	}
	const prefix = "data:image/png;base64,"
	if len(data.Content) != 2 || data.Content[1].Role != "first_frame" || !strings.HasPrefix(data.Content[1].Image.URL, prefix) {
		t.Fatal("local first frame was not attached as an image data URI")
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(data.Content[1].Image.URL, prefix))
	if err != nil || !bytes.Equal(raw, original.Bytes()) {
		t.Fatal("local image bytes changed")
	}
	input.References[0].Path = "assets/images/../../escape.png"
	if _, err := provider.payload(input); err == nil {
		t.Fatal("an escaping local path was accepted")
	}
}

func TestArkSubmitClassifiesRejectionAndUnknownOutcome(t *testing.T) {
	ctx := context.Background()
	profile := ProviderProfile{Provider: "ark", Mode: "t2v", Model: "doubao-seedance-2-0-260128"}
	input := GenerationInput{Type: "video", Mode: "t2v", Prompt: "Scene"}
	for _, fixture := range []struct {
		code     int
		body     string
		rejected bool
	}{
		{400, "{\"message\":\"private fixture detail\"}", true},
		{401, "{\"message\":\"private fixture detail\"}", true},
		{429, "{\"message\":\"private fixture detail\"}", true},
		{502, "{\"message\":\"private fixture detail\"}", false},
		{200, "{\"id\":\"../untrusted\"}", false},
	} {
		client := &http.Client{Transport: arkFixtureTransport(func(*http.Request) (*http.Response, error) {
			return arkFixtureResponse(fixture.code, fixture.body)
		})}
		result, err := newArkProvider(profile, "fixture", client).Submit(ctx, input)
		if err == nil || result.Rejected != fixture.rejected || result.TaskID != "" || strings.Contains(err.Error(), "private fixture detail") {
			t.Fatalf("HTTP %d: submit = %+v, %v", fixture.code, result, err)
		}
	}
}

func TestArkRejectsUnsupportedModesAndCredentialRedirects(t *testing.T) {
	ctx := context.Background()
	redirectCalls := 0
	client := &http.Client{Transport: arkFixtureTransport(func(req *http.Request) (*http.Response, error) {
		redirectCalls++
		if req.URL.Host != "ark.cn-beijing.volces.com" {
			t.Fatal("Ark credential redirect was followed")
		}
		recorder := httptest.NewRecorder()
		recorder.Header().Set("Location", "https://other.example.test/external")
		recorder.WriteHeader(http.StatusTemporaryRedirect)
		return recorder.Result(), nil
	})}
	profile := ProviderProfile{Provider: "ark", Mode: "r2v", Model: "doubao-seedance-2-0-260128"}
	p := newArkProvider(profile, "fixture", client).(*arkProvider)
	input := GenerationInput{Type: "video", Mode: "r2v", Prompt: "Scene"}
	invalidReferences := [][]GenerationReference{
		nil,
		{{Type: "video", URL: "https://assets.example.test/ref.mp4"}},
		{{Type: "image", URL: "http://127.0.0.1/frame.png"}},
		{{Type: "image", URL: "data:image/png;base64,AAAA"}},
	}
	for _, references := range invalidReferences {
		input.References = references
		result, err := p.Submit(ctx, input)
		if err == nil || !result.Rejected {
			t.Fatalf("unsupported inputs were not rejected: %+v", references)
		}
	}
	if redirectCalls != 0 {
		t.Fatal("unsupported inputs triggered an outbound request")
	}
	input.References = []GenerationReference{{Type: "image", URL: "https://assets.example.test/frame.png"}}
	result, err := p.Submit(ctx, input)
	if err == nil || result.Rejected || redirectCalls != 1 {
		t.Fatalf("redirect = %+v, %v, calls=%d", result, err, redirectCalls)
	}
	if err := p.Download(ctx, ProviderResult{URL: "https://[::1]/ref.mp4"}, io.Discard); err == nil || redirectCalls != 1 {
		t.Fatal("loopback output attempted a network request")
	}
}
