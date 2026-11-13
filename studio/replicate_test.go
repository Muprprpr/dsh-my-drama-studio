package studio

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
)

type replicateFixtureTransport func(*http.Request) (*http.Response, error)

func (f replicateFixtureTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	return f(r)
}

func replicateFixtureClient(t *testing.T, handler http.HandlerFunc) *http.Client {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	fixtureURL, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	return &http.Client{Transport: replicateFixtureTransport(func(request *http.Request) (*http.Response, error) {
		routed := request.Clone(request.Context())
		routed.Host = request.URL.Host
		routed.URL.Host = fixtureURL.Host
		routed.URL.Scheme = fixtureURL.Scheme
		return http.DefaultTransport.RoundTrip(routed)
	})}
}

func TestReplicatePredictionModes(t *testing.T) {
	const (
		prompt   = "完整镜头提示，人物从左向右走。"
		imageOne = "https://images.example/hero.png"
		imageTwo = "https://images.example/coat.png"
	)
	version := strings.Repeat("a", 64)
	for _, test := range []struct {
		name, nodeType, mode, model, field, endpoint, version, extension string
		references                                                       []GenerationReference
		expectedMedia                                                    any
		imageLimit                                                       int
	}{
		{name: "T2I Flux", nodeType: "image", mode: "t2i", model: "black-forest-labs/flux-schnell",
			endpoint: "/v1/models/black-forest-labs/flux-schnell/predictions", extension: ".webp"},
		{name: "T2I single reference", nodeType: "image", mode: "t2i", model: "black-forest-labs/flux-kontext-pro",
			field: "input_image", endpoint: "/v1/models/black-forest-labs/flux-kontext-pro/predictions", extension: ".png",
			references: []GenerationReference{{Type: "image", URL: imageOne}}, expectedMedia: imageOne, imageLimit: 1},
		{name: "T2I multiple references", nodeType: "image", mode: "t2i", model: "example/image-model",
			field: "image_inputs", endpoint: "/v1/models/example/image-model/predictions", extension: ".png",
			references:    []GenerationReference{{Type: "image", URL: imageOne}, {Type: "image", URL: imageTwo}},
			expectedMedia: []any{imageOne, imageTwo}, imageLimit: 3},
		{name: "T2V Wan", nodeType: "video", mode: "t2v", model: "wan-video/wan-2.7-t2v",
			endpoint: "/v1/models/wan-video/wan-2.7-t2v/predictions", extension: ".mp4"},
		{name: "I2V versioned Wan", nodeType: "video", mode: "i2v", model: "wan-video/wan-2.7-i2v:" + version,
			field: "first_frame", endpoint: "/v1/predictions", version: "wan-video/wan-2.7-i2v:" + version, extension: ".mp4",
			references: []GenerationReference{{Type: "image", URL: imageOne}}, expectedMedia: imageOne},
		{name: "R2V Veo", nodeType: "video", mode: "r2v", model: "google/veo-3.1",
			field: "reference_images", endpoint: "/v1/models/google/veo-3.1/predictions", extension: ".mp4",
			references: []GenerationReference{{Type: "image", URL: imageOne}, {Type: "image", URL: imageTwo}}, expectedMedia: []any{imageOne, imageTwo}},
	} {
		t.Run(test.name, func(t *testing.T) {
			fileURL := "https://files.replicate.delivery/predictions/output" + test.extension + "?token=fixture"
			var polls atomic.Int32
			client := replicateFixtureClient(t, func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer fixture-token" {
					t.Error("bearer token missing on documented Replicate host")
				}
				switch r.Host + " " + r.Method + " " + r.URL.Path {
				case "api.replicate.com GET /v1/account":
					io.WriteString(w, "{\"username\":\"fixture\"}")
				case "api.replicate.com POST " + test.endpoint:
					if r.Header.Get("Content-Type") != "application/json" || r.Header.Get("Prefer") != "" {
						t.Error("prediction must use asynchronous JSON request")
					}
					var body replicatePredictionInput
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
						t.Errorf("decode prediction: %v", err)
					}
					want := map[string]any{"prompt": prompt, "seed": float64(31)}
					if test.field != "" {
						want[test.field] = test.expectedMedia
					}
					if !reflect.DeepEqual(body.Input, want) || body.Version != test.version {
						t.Errorf("prediction = %+v, want version %q and %+v", body, test.version, want)
					}
					w.WriteHeader(http.StatusAccepted)
					io.WriteString(w, "{\"id\":\"prediction-1\",\"status\":\"starting\"}")
				case "api.replicate.com GET /v1/predictions/prediction-1":
					status := "succeeded"
					var output any = fileURL
					switch polls.Add(1) {
					case 1:
						status, output = "starting", nil
					case 2:
						status, output = "processing", nil
					default:
						if test.nodeType == "image" {
							output = []string{fileURL}
						}
					}
					json.NewEncoder(w).Encode(map[string]any{"id": "prediction-1", "status": status, "output": output})
				case "files.replicate.delivery GET /predictions/output" + test.extension:
					w.Header().Set("Content-Type", "application/octet-stream")
					io.WriteString(w, "media fixture bytes")
				default:
					t.Errorf("unexpected request %s %s %s", r.Host, r.Method, r.URL.Path)
					w.WriteHeader(http.StatusNotFound)
				}
			})
			ctx := context.Background()
			provider := newReplicateProvider(ProviderProfile{Mode: test.mode, Model: test.model, InputField: test.field,
				Options: map[string]any{"seed": 31},
				Limits:  VideoLimits{References: map[string]int{"image": test.imageLimit}}}, "fixture-token", client)
			if err := provider.(interface{ Verify(context.Context) error }).Verify(ctx); err != nil {
				t.Fatal(err)
			}
			submitted, err := provider.Submit(ctx, GenerationInput{Type: test.nodeType, Mode: test.mode, Prompt: prompt, References: test.references})
			if err != nil || submitted.TaskID != "prediction-1" || submitted.Rejected {
				t.Fatalf("submit = %+v, %v", submitted, err)
			}
			var output ProviderResult
			for _, status := range []string{"pending", "running", "succeeded"} {
				output, err = provider.Poll(ctx, submitted.TaskID)
				if err != nil || output.Status != status {
					t.Fatalf("poll = %+v, %v, want %s", output, err, status)
				}
			}
			if output.URL != fileURL || output.Extension != test.extension {
				t.Fatalf("poll result = %+v", output)
			}
			var downloaded bytes.Buffer
			if err := provider.Download(ctx, output, &downloaded); err != nil || downloaded.String() != "media fixture bytes" {
				t.Fatalf("download = %q, %v", downloaded.String(), err)
			}
		})
	}
}

func TestReplicateUploadsLocalImageBeforePrediction(t *testing.T) {
	const relative = "assets/images/reference.png"
	workspace := t.TempDir()
	target := filepath.Join(workspace, filepath.FromSlash(relative))
	if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
		t.Fatal(err)
	}
	var source bytes.Buffer
	if err := png.Encode(&source, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, source.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	const uploaded = "https://api.replicate.com/v1/files/opaque-fixture-id"
	var requests atomic.Int32
	client := replicateFixtureClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Host != "api.replicate.com" || r.Method != http.MethodPost || r.Header.Get("Authorization") != "Bearer fixture-token" {
			t.Errorf("unexpected request %s %s", r.Method, r.Host)
		}
		switch r.URL.Path {
		case "/v1/files":
			if requests.Add(1) != 1 {
				t.Error("upload must precede prediction")
			}
			reader, err := r.MultipartReader()
			if err != nil {
				t.Errorf("multipart: %v", err)
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			part, err := reader.NextPart()
			if err != nil {
				t.Errorf("content part: %v", err)
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			content, err := io.ReadAll(part)
			if err != nil || part.FormName() != "content" || part.FileName() != "reference.png" ||
				part.Header.Get("Content-Type") != "image/png" || !bytes.Equal(content, source.Bytes()) {
				t.Errorf("invalid upload part %q %q, bytes=%d, %v", part.FormName(), part.FileName(), len(content), err)
			}
			w.WriteHeader(http.StatusCreated)
			json.NewEncoder(w).Encode(map[string]any{"urls": map[string]string{"get": uploaded}})
		case "/v1/models/wan-video/wan-2.7-i2v/predictions":
			if requests.Add(1) != 2 {
				t.Error("prediction must follow the local upload")
			}
			var body replicatePredictionInput
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Input["first_frame"] != uploaded {
				t.Errorf("prediction should use opaque upload URL: %+v, %v", body, err)
			}
			w.WriteHeader(http.StatusCreated)
			io.WriteString(w, "{\"id\":\"prediction-2\",\"status\":\"starting\"}")
		default:
			t.Errorf("unexpected request %q", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	})
	provider := newReplicateProvider(ProviderProfile{Mode: "i2v", Model: "wan-video/wan-2.7-i2v", InputField: "first_frame"}, "fixture-token", client)
	result, err := provider.Submit(context.Background(), GenerationInput{Type: "video", Mode: "i2v", Prompt: "Animate the first frame.",
		WorkspacePath: workspace, References: []GenerationReference{{Type: "image", Path: relative}}})
	if err != nil || result.TaskID != "prediction-2" || requests.Load() != 2 {
		t.Fatalf("local submission = %+v, %v, requests = %d", result, err, requests.Load())
	}
}

func TestReplicateRejectsInvalidInputsAndDoesNotRetrySubmission(t *testing.T) {
	ctx := context.Background()
	for _, test := range []struct {
		name       string
		profile    ProviderProfile
		references []GenerationReference
	}{
		{name: "path-like model", profile: ProviderProfile{Mode: "t2v", Model: "https://third-party.example/model"}},
		{name: "prompt override", profile: ProviderProfile{Mode: "t2v", Model: "google/veo-3.1", Options: map[string]any{"prompt": "wrong"}}},
		{name: "video option override", profile: ProviderProfile{Mode: "t2v", Model: "google/veo-3.1", Options: map[string]any{"reference_videos": "clip"}}},
		{name: "text option override", profile: ProviderProfile{Mode: "t2v", Model: "google/veo-3.1", Options: map[string]any{"negative_prompt": "other text"}}},
		{name: "V2V input", profile: ProviderProfile{Mode: "r2v", Model: "google/veo-3.1", InputField: "reference_images"},
			references: []GenerationReference{{Type: "video", URL: "https://media.example/video.mp4"}}},
		{name: "localhost input", profile: ProviderProfile{Mode: "i2v", Model: "google/veo-3.1", InputField: "image"},
			references: []GenerationReference{{Type: "image", URL: "http://localhost/preview.png"}}},
		{name: "local traversal", profile: ProviderProfile{Mode: "i2v", Model: "google/veo-3.1", InputField: "image"},
			references: []GenerationReference{{Type: "image", Path: "assets/images/../private.png"}}},
	} {
		t.Run(test.name, func(t *testing.T) {
			client := &http.Client{Transport: replicateFixtureTransport(func(*http.Request) (*http.Response, error) {
				t.Fatal("invalid input reached the network")
				return nil, nil
			})}
			provider := newReplicateProvider(test.profile, "fixture-token", client)
			input := GenerationInput{Type: "video", Mode: test.profile.Mode, Prompt: "A complete prompt.", References: test.references}
			if err := provider.(interface{ Validate(GenerationInput) error }).Validate(input); err == nil {
				t.Fatal("invalid input passed preflight")
			}
			result, err := provider.Submit(ctx, input)
			if err == nil || !result.Rejected || result.TaskID != "" {
				t.Fatalf("invalid submit = %+v, %v", result, err)
			}
		})
	}

	for _, test := range []struct {
		code     int
		rejected bool
	}{
		{http.StatusTooManyRequests, true}, {http.StatusServiceUnavailable, false}, {http.StatusTemporaryRedirect, false},
		{http.StatusCreated, false},
	} {
		var requests atomic.Int32
		client := replicateFixtureClient(t, func(w http.ResponseWriter, _ *http.Request) {
			requests.Add(1)
			w.Header().Set("Location", "https://third-party.example/submit")
			w.WriteHeader(test.code)
			io.WriteString(w, "{\"invalid\":\"response\"}")
		})
		provider := newReplicateProvider(ProviderProfile{Mode: "t2v", Model: "google/veo-3.1"}, "fixture-token", client)
		submission, err := provider.Submit(ctx, GenerationInput{Type: "video", Prompt: "A complete prompt."})
		if err == nil || submission.Rejected != test.rejected || requests.Load() != 1 {
			t.Errorf("HTTP %d: submission=%+v err=%v requests=%d", test.code, submission, err, requests.Load())
		}
	}
}

func TestReplicateOutputDoesNotSendBearerToUntrustedHost(t *testing.T) {
	var requests atomic.Int32
	client := replicateFixtureClient(t, func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if r.Host != "replicate.delivery" {
			t.Errorf("download reached unexpected host %s", r.Host)
		}
		http.Redirect(w, r, "https://replicate.delivery.example.org/output.mp4", http.StatusFound)
	})
	provider := newReplicateProvider(ProviderProfile{Mode: "t2v", Model: "google/veo-3.1"}, "fixture-token", client)
	for _, asset := range []string{"https://replicate.delivery.example.org/output.mp4", "https://replicate.delivery/output.mp4"} {
		if err := provider.Download(context.Background(), ProviderResult{URL: asset}, io.Discard); err == nil {
			t.Errorf("untrusted download accepted: %s", asset)
		}
	}
	if requests.Load() != 1 {
		t.Fatalf("download must not follow external redirect, got %d requests", requests.Load())
	}
}
