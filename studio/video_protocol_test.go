package studio

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

var protocolTestVideo = []byte{0, 0, 0, 24, 'f', 't', 'y', 'p', 'i', 's', 'o', 'm', 0, 0, 0, 0,
	'i', 's', 'o', 'm', 'm', 'p', '4', '2'}

func protocolBody(t *testing.T, req *http.Request) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		t.Errorf("decode submit request: %v", err)
	}
	return body
}

func protocolFixture(channel VideoChannel, client *http.Client) *videoProvider {
	profile := ProviderProfile{Model: "provider/demo", Channel: &channel}
	return newVideoProvider(profile, "fixture-video-key", client).(*videoProvider)
}

func TestNewAPIVideoLegacy(t *testing.T) {
	polls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Header.Get("Authorization") != "Bearer fixture-video-key" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		switch req.Method + " " + req.URL.Path {
		case "POST /relay/v1/video/generations":
			body := protocolBody(t, req)
			if body["prompt"] != "Full prompt\nSecond line" || body["model"] != "provider/demo" ||
				body["width"] != float64(1280) || body["height"] != float64(720) ||
				body["duration"] != float64(5) || body["image"] != "https://media.example.com/first.png" ||
				body["generate_audio"] != nil {
				t.Errorf("legacy request mismatch: %#v", body)
			}
			fmt.Fprint(w, `{"task_id":"task-1","status":"queued"}`)
		case "GET /relay/v1/video/generations/task-1":
			polls++
			if polls == 1 {
				fmt.Fprint(w, `{"task_id":"task-1","status":"queued"}`)
			} else {
				fmt.Fprint(w, `{"code":"success","data":{"task_id":"task-1","status":"SUCCESS","result_url":"/relay/v1/videos/task-1/content"}}`)
			}
		case "GET /relay/v1/videos/task-1/content":
			_, _ = w.Write(protocolTestVideo)
		case "GET /relay/v1/models":
			fmt.Fprint(w, `{"object":"list","data":[{"id":"provider/demo"}]}`)
		default:
			t.Errorf("unexpected New API route %s %s", req.Method, req.URL)
			http.NotFound(w, req)
		}
	}))
	defer server.Close()

	p := protocolFixture(VideoChannel{Protocol: "new-api", BaseURL: server.URL + "/relay/v1"}, server.Client())
	audio := true
	input := GenerationInput{Type: "video", Mode: "i2v", Prompt: "Full prompt\nSecond line",
		Params:     VideoParams{Duration: 5, Resolution: "720p", AspectRatio: "16:9", GenerateAudio: &audio},
		References: []GenerationReference{{Type: "image", URL: "https://media.example.com/first.png"}}}
	protocolSubmitAndDownload(t, p, input, "task-1", "pending", "succeeded")
	probe := p.Probe(context.Background(), "provider/demo")
	if !probe.ConfigValid || probe.Authentication != "verified" || probe.ModelCallable != "listed" || probe.TaskSucceeded != "unverified" {
		t.Fatalf("unexpected probe evidence: %+v", probe)
	}
}

func TestNewAPITaskUsesDiscoveredVideoArtifact(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		switch req.Method + " " + req.URL.Path {
		case "POST /v1/tasks/xai":
			body := protocolBody(t, req)
			if videoField(body, "reference_images.0") != "https://media.example.com/frame.png" ||
				videoField(body, "reference_audios.0.url") != "https://media.example.com/dialogue.wav" {
				t.Errorf("unexpected xAI request: %#v", body)
			}
			fmt.Fprint(w, `{"id":"task-2","task_id":"task-2","status":"queued"}`)
		case "GET /v1/tasks/task-2":
			fmt.Fprint(w, `{"task_id":"task-2","status":"SUCCESS"}`)
		case "GET /v1/tasks/task-2/artifacts":
			fmt.Fprint(w, `{"artifacts":[{"key":"thumbnail","type":"image","mime_type":"image/png"},{"key":"final-cut","type":"video","mime_type":"video/mp4"}]}`)
		case "GET /v1/tasks/task-2/artifacts/final-cut/content":
			_, _ = w.Write(protocolTestVideo)
		default:
			t.Errorf("unexpected New API Task route %s %s", req.Method, req.URL)
			http.NotFound(w, req)
		}
	}))
	defer server.Close()
	p := protocolFixture(VideoChannel{Protocol: "new-api", BaseURL: server.URL, TaskPlugin: "xai"}, server.Client())
	input := GenerationInput{Type: "video", Mode: "r2v", Prompt: "Retain the movement and audio.",
		References: []GenerationReference{
			{Type: "audio", URL: "https://media.example.com/dialogue.wav"},
			{Type: "image", URL: "https://media.example.com/frame.png"},
		}}
	protocolSubmitAndDownload(t, p, input, "task-2", "succeeded")
	input.References = append(input.References, GenerationReference{Type: "video", URL: "https://media.example.com/video.mp4"})
	if err := p.Validate(input); err == nil {
		t.Fatal("New API xAI should reject unsupported video references")
	}
}

func TestOpenAIVideoUsesReferenceObjectAndContentEndpoint(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		switch req.Method + " " + req.URL.Path {
		case "POST /v1/videos":
			body := protocolBody(t, req)
			if body["seconds"] != "4" || body["size"] != "720x1280" ||
				videoField(body, "input_reference.image_url") != "https://media.example.com/first.png" ||
				body["generate_audio"] != nil || body["aspect_ratio"] != nil {
				t.Errorf("unexpected OpenAI-compatible request: %#v", body)
			}
			fmt.Fprint(w, `{"id":"video_1","status":"queued"}`)
		case "GET /v1/videos/video_1":
			fmt.Fprint(w, `{"id":"video_1","status":"completed"}`)
		case "GET /v1/videos/video_1/content":
			_, _ = w.Write(protocolTestVideo)
		case "GET /v1/models":
			fmt.Fprint(w, `{"status":"ok"}`)
		default:
			http.NotFound(w, req)
		}
	}))
	defer server.Close()
	p := protocolFixture(VideoChannel{Protocol: "openai-video", BaseURL: server.URL}, server.Client())
	audio := true
	input := GenerationInput{Type: "video", Mode: "i2v", Prompt: "Camera rolls.",
		Params:     VideoParams{Duration: 4, Resolution: "720x1280", AspectRatio: "9:16", GenerateAudio: &audio},
		References: []GenerationReference{{Type: "image", URL: "https://media.example.com/first.png"}}}
	protocolSubmitAndDownload(t, p, input, "video_1", "succeeded")
	input.References = append(input.References, input.References[0])
	if err := p.Validate(input); err == nil {
		t.Fatal("OpenAI basic video create should reject an unsupported tail frame")
	}
	input.References = input.References[:1]
	input.Params.Resolution = ""
	if err := p.Validate(input); err == nil {
		t.Fatal("OpenAI basic video create cannot pass a standalone aspect ratio")
	}
	if probe := p.Probe(context.Background(), "provider/demo"); probe.Authentication != "unverified" || probe.ModelCallable != "unverified" {
		t.Fatalf("plain HTTP 200 must not pass a connection check: %+v", probe)
	}
	verified := successfulProbe(VideoProbe{Authentication: "verified", ModelCallable: "listed",
		Message: videoModelCatalogMessage}, p.channel)
	if verified.TaskSucceeded != "verified" || verified.ModelCallable != "verified" || verified.Message != "" {
		t.Fatalf("a completed task should supersede the model-catalog message: %+v", verified)
	}
}

func TestCustomRESTMapsV2VAndChecksAuthentication(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Header.Get("X-Video-Key") != "fixture-video-key" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if req.Header.Get("Authorization") != "" {
			t.Error("Custom REST header authentication unexpectedly sent a bearer token")
		}
		switch req.Method + " " + req.URL.Path {
		case "PATCH /api/jobs":
			body := protocolBody(t, req)
			if videoField(body, "options.source") != "https://media.example.com/source.mp4" ||
				videoField(body, "options.assets") != nil ||
				videoField(body, "options.sound") != false ||
				videoField(body, "options.prompt") != "Edit the motion." ||
				videoField(body, "resolution") != nil {
				t.Errorf("unexpected custom payload: %#v", body)
			}
			fmt.Fprint(w, `{"result":{"id":"job:1"}}`)
		case "POST /api/query":
			if req.URL.Query().Get("task") != "job:1" {
				t.Errorf("task ID was incorrectly encoded: %s", req.URL)
			}
			fmt.Fprint(w, `{"result":{"id":"job:1","phase":"done","files":[{"download":"/api/content.mp4"}]}}`)
		case "GET /api/content.mp4":
			_, _ = w.Write(protocolTestVideo)
		case "GET /api/account":
			fmt.Fprint(w, `{"account":"authorized"}`)
		case "GET /api/models/provider/demo":
			fmt.Fprint(w, `{"data":{"id":"provider/demo"}}`)
		default:
			t.Errorf("unexpected Custom REST route %s %s", req.Method, req.URL)
			http.NotFound(w, req)
		}
	}))
	defer server.Close()
	channel := VideoChannel{Protocol: "custom-rest", BaseURL: server.URL + "/api", Advanced: &CustomREST{
		SubmitURL: "/jobs", SubmitMethod: "PATCH", Auth: "header", AuthHeader: "X-Video-Key",
		Fields:     map[string]string{"prompt": "options.prompt", "sourceVideo": "options.source", "references": "options.assets", "generateAudio": "options.sound"},
		TaskIDPath: "result.id", QueryURL: "/query?task={taskId}", QueryMethod: "POST",
		StatusPath: "result.phase", StatusMap: map[string]string{"done": "completed", "error": "failed"},
		OutputURLPath: "result.files.0.download", ProbeURL: "/account", ModelProbeURL: "/models/{model}",
	}}
	p := protocolFixture(channel, server.Client())
	audio := false
	input := GenerationInput{Type: "video", Mode: "v2v", Prompt: "Edit the motion.",
		Params: VideoParams{Resolution: "ignored-by-adapter", GenerateAudio: &audio},
		References: []GenerationReference{
			{Type: "video", URL: "https://media.example.com/source.mp4"},
		}}
	protocolSubmitAndDownload(t, p, input, "job:1", "succeeded")
	input.Mode = "r2v"
	input.References = append(input.References, GenerationReference{Type: "audio", URL: "https://media.example.com/audio.wav"})
	if err := p.Validate(input); err != nil {
		t.Fatal(err)
	}
	body := p.customPayload(input, []string{input.References[0].URL, input.References[1].URL})
	media, _ := videoField(body, "options.assets").([]map[string]string)
	if len(media) != 2 || media[0]["type"] != "video" || media[1]["url"] != input.References[1].URL {
		t.Fatalf("custom R2V did not preserve ordered media: %#v", body)
	}
	probe := p.Probe(context.Background(), "provider/demo")
	if probe.Authentication != "verified" || probe.ModelCallable != "listed" || probe.TaskSucceeded != "unverified" {
		t.Fatalf("custom auth challenge and model lookup failed: %+v", probe)
	}
	channel.Advanced.Fields["duration"] = "options"
	if err := validateVideoChannel(channel); err == nil {
		t.Fatal("custom field path collisions must be rejected")
	}
	delete(channel.Advanced.Fields, "duration")
	channel.Advanced.QueryURL = "https://other.example.com/{taskId}"
	if err := validateVideoChannel(channel); err == nil {
		t.Fatal("credentials must not be configured to follow another query origin")
	}
}

func TestCustomRESTDownloadsFromTaskURLTemplate(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Header.Get("Authorization") != "Bearer fixture-video-key" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		switch req.Method + " " + req.URL.Path {
		case "POST /api/v1/videos":
			body := protocolBody(t, req)
			if body["seconds"] != float64(4) || body["size"] != "1280x720" || body["aspectRatio"] != nil {
				t.Errorf("unexpected Custom REST request: %#v", body)
			}
			fmt.Fprint(w, `{"id":"job:1","status":"queued"}`)
		case "GET /api/v1/videos/job:1":
			fmt.Fprint(w, `{"id":"job:1","status":"completed"}`)
		case "GET /api/v1/videos/job:1/content":
			_, _ = w.Write(protocolTestVideo)
		default:
			t.Errorf("unexpected Custom REST route %s %s", req.Method, req.URL)
			http.NotFound(w, req)
		}
	}))
	defer server.Close()
	channel := VideoChannel{Protocol: "custom-rest", BaseURL: server.URL + "/api", Advanced: &CustomREST{
		SubmitURL: "/v1/videos", SubmitMethod: "POST", Auth: "bearer",
		TaskIDPath: "id", QueryURL: "/v1/videos/{taskId}", StatusPath: "status",
		DownloadURL: "/v1/videos/{taskId}/content",
		StatusMap:   map[string]string{"completed": "completed", "failed": "failed"},
		Fields:      map[string]string{"duration": "seconds", "resolution": "size"},
	}}
	input := GenerationInput{Type: "video", Mode: "t2v", Prompt: "Move the light.",
		Params: VideoParams{Duration: 4, Resolution: "1280x720", AspectRatio: "16:9"}}
	protocolSubmitAndDownload(t, protocolFixture(channel, server.Client()), input, "job:1", "succeeded")
	channel.Advanced.OutputURLPath = "video.url"
	if err := validateVideoChannel(channel); err == nil {
		t.Fatal("a download template and output field must not both be set")
	}
	channel.Advanced.OutputURLPath = ""
	for _, endpoint := range []string{"/content", "https://other.example.com/{taskId}/content"} {
		channel.Advanced.DownloadURL = endpoint
		if err := validateVideoChannel(channel); err == nil {
			t.Fatalf("accepted invalid download template %s", endpoint)
		}
	}
}

func TestVideoProtocolErrorsAndCredentiallessRedirect(t *testing.T) {
	t.Run("HTTP classes and redaction", func(t *testing.T) {
		for _, status := range []int{401, 404, 429, 503} {
			t.Run(fmt.Sprint(status), func(t *testing.T) {
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
					w.WriteHeader(status)
					fmt.Fprint(w, `{"error":{"message":"permission denied fixture-video-key https://cdn.example.com/a?token=secret"}}`)
				}))
				defer server.Close()
				p := protocolFixture(VideoChannel{Protocol: "openai-video", BaseURL: server.URL}, server.Client())
				_, err := p.Poll(context.Background(), "task-3")
				var requestErr *providerRequestError
				if !errors.As(err, &requestErr) || requestErr.Permanent() != (status < 429) ||
					!strings.Contains(err.Error(), "permission denied") || strings.Contains(err.Error(), "fixture-video-key") ||
					strings.Contains(err.Error(), "token=secret") {
					t.Fatalf("unexpected safe status %d: %v", status, err)
				}
			})
		}
	})
	t.Run("cross-origin redirect", func(t *testing.T) {
		client := &http.Client{Transport: arkFixtureTransport(func(req *http.Request) (*http.Response, error) {
			response := &http.Response{Header: make(http.Header), Request: req, StatusCode: http.StatusOK}
			switch req.URL.Host {
			case "api.example.com":
				if req.Header.Get("Authorization") != "Bearer fixture-video-key" {
					t.Error("same-origin content request lost its bearer")
				}
				response.StatusCode = http.StatusFound
				response.Header.Set("Location", "https://cdn.example.com/video.mp4?private=1")
				response.Body = http.NoBody
			case "cdn.example.com":
				if req.Header.Get("Authorization") != "" {
					t.Error("redirect leaked the bearer key")
				}
				response.Body = io.NopCloser(bytes.NewReader(protocolTestVideo))
			default:
				t.Errorf("unexpected redirect host %s", req.URL.Host)
				response.StatusCode, response.Body = http.StatusBadRequest, http.NoBody
			}
			return response, nil
		})}
		p := protocolFixture(VideoChannel{Protocol: "openai-video", BaseURL: "https://api.example.com"}, client)
		if err := p.Download(context.Background(), ProviderResult{URL: "https://api.example.com/v1/videos/id/content"}, io.Discard); err != nil {
			t.Fatal(err)
		}
		if _, err := p.outputURL("http://127.0.0.1/file.mp4"); err == nil {
			t.Fatal("cross-origin loopback output was accepted")
		}
	})
}

func protocolSubmitAndDownload(t *testing.T, p Provider, input GenerationInput, taskID string, statuses ...string) {
	t.Helper()
	ctx := context.Background()
	submitted, err := p.Submit(ctx, input)
	if err != nil || submitted.Rejected || submitted.TaskID != taskID {
		t.Fatalf("submit = %+v, %v", submitted, err)
	}
	var result ProviderResult
	for _, status := range statuses {
		result, err = p.Poll(ctx, submitted.TaskID)
		if err != nil || result.Status != status {
			t.Fatalf("poll = %+v, %v; want %q", result, err, status)
		}
	}
	var output bytes.Buffer
	if err := p.Download(ctx, result, &output); err != nil || result.Extension != ".mp4" ||
		!bytes.Equal(output.Bytes(), protocolTestVideo) {
		t.Fatalf("download extension=%s bytes=%d error=%v", result.Extension, output.Len(), err)
	}
}
