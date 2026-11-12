package studio

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"
)

type testTransport func(*http.Request) (*http.Response, error)

func (transport testTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	return transport(req)
}

func TestProviderSettingsProtectedPersistence(t *testing.T) {
	path := filepath.Join(t.TempDir(), "providers.dpapi")
	settings, err := OpenProviderSettings(path)
	if err != nil {
		t.Fatal(err)
	}
	const key = "fixture-not-a-live-provider-token"
	profile := ProviderProfile{Name: "Veo Reference", Provider: "replicate", Mode: "r2v", Model: "google/veo-3.1", InputField: "reference_images"}
	keyValue := key
	if err := settings.save(profile, &keyValue, true); err != nil {
		t.Fatal(err)
	}
	encrypted, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(encrypted, []byte(key)) || json.Valid(encrypted) {
		t.Fatal("Settings file contains plaintext data")
	}
	settings, err = OpenProviderSettings(path)
	if err != nil {
		t.Fatal(err)
	}
	view := settings.view()
	profiles := view["profiles"].([]providerView)
	if len(profiles) != 1 || !profiles[0].Configured || !profiles[0].Default {
		t.Fatalf("Unexpected provider settings: %+v", profiles)
	}
	visible, err := json.Marshal(view)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(visible, []byte(key)) {
		t.Fatal("Credential leaked through settings readback")
	}
	input := GenerationInput{Type: "video", Mode: "r2v", Prompt: "Fixture",
		References: []GenerationReference{{Type: "image", Path: "assets/images/frame.png"}}}
	if err := settings.Prepare(&input, ""); err != nil {
		t.Fatal(err)
	}
	if input.Profile.ID != profiles[0].ID || input.Profile.Model != profile.Model {
		t.Fatal("Default preset not selected")
	}
	if err := settings.remove(input.Profile.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := settings.Resolve(input.Profile); err != nil {
		t.Fatal("Preset removal must preserve credentials for queued tasks:", err)
	}
	if err := settings.Prepare(&input, ""); err == nil {
		t.Fatal("Removed preset selected for a new task")
	}
}

func TestConfiguredProviderJobKeepsPresetAcrossEdits(t *testing.T) {
	ctx := context.Background()
	settings, err := OpenProviderSettings(filepath.Join(t.TempDir(), "providers.dpapi"))
	if err != nil {
		t.Fatal(err)
	}
	const token = "fixture-token"
	key := token
	initial := ProviderProfile{Name: "Wan Text", Provider: "replicate", Mode: "t2v", Model: "wan-video/wan-2.7-t2v"}
	if err := settings.save(initial, &key, true); err != nil {
		t.Fatal(err)
	}
	settings.client.Transport = testTransport(func(req *http.Request) (*http.Response, error) {
		if req.Header.Get("Authorization") != "Bearer "+token {
			t.Fatal("Expected provider credential")
		}
		var body string
		switch req.Method + " " + req.URL.Host + req.URL.Path {
		case "POST api.replicate.com/v1/models/wan-video/wan-2.7-t2v/predictions":
			var payload struct{ Input map[string]any }
			if err := json.NewDecoder(req.Body).Decode(&payload); err != nil || payload.Input["prompt"] != "Full fixture prompt" {
				t.Fatalf("Wrong provider payload: %+v %v", payload, err)
			}
			body = `{"id":"fixture-task","status":"starting"}`
		case "GET api.replicate.com/v1/predictions/fixture-task":
			body = `{"id":"fixture-task","status":"succeeded","output":"https://replicate.delivery/demo/fixture.mp4"}`
		case "GET replicate.delivery/demo/fixture.mp4":
			body = "fixture video bytes"
		default:
			t.Fatalf("Unexpected fixture request %s %s", req.Method, req.URL)
		}
		code := 200
		if req.Method == "POST" {
			code = 201
		}
		return &http.Response{StatusCode: code, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}, nil
	})
	service := New(settings)
	defer service.Close()
	dir := t.TempDir()
	bindSession(t, service, dir, "a")
	draftID := uuid.NewString()
	mustCall(t, service, dir, "a", "append", appendArgs{operation: operation{ID: "draft"}, Nodes: []NodeInput{
		{ID: draftID, Type: "video", Content: json.RawMessage(`{"prompt":"Full fixture prompt","mode":"t2v"}`)},
	}})
	mustCall(t, service, dir, "a", "submit_manual", map[string]any{
		"operationId": "submit", "nodeId": draftID, "confirmed": true,
	})
	project, err := service.open(ctx, dir, false)
	if err != nil {
		t.Fatal(err)
	}
	var input string
	if err := project.db.QueryRow("SELECT input FROM tasks").Scan(&input); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(input, token) {
		t.Fatal("Provider key stored in task snapshot")
	}
	preset := settings.view()["profiles"].([]providerView)[0].ProviderProfile
	preset.Model = "google/veo-3.1"
	if err := settings.save(preset, nil, true); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := project.advance(ctx, settings); err != nil {
			t.Fatal(err)
		}
	}
	tasks := tasksIn(t, service, dir, "a")
	if len(tasks) != 1 || tasks[0].Status != "succeeded" || tasks[0].ProviderTaskID != "fixture-task" ||
		tasks[0].Model != initial.Model || tasks[0].ResultNodeID == "" {
		t.Fatalf("Unexpected routed task: %+v", tasks)
	}
}

func TestProviderTemplatesAndModeConstraints(t *testing.T) {
	for _, profile := range providerTemplates() {
		if err := validateProfile(profile); err != nil {
			t.Errorf("%s %s: %v", profile.Provider, profile.Name, err)
		}
	}
	for _, tc := range []struct {
		mode  string
		count int
		want  bool
	}{
		{"t2v", 0, true}, {"t2v", 1, false}, {"i2v", 1, true}, {"i2v", 2, false},
		{"r2v", 1, true}, {"r2v", 0, false}, {"v2v", 1, false},
	} {
		if validVideoMode(tc.mode, tc.count) != tc.want {
			t.Errorf("%s with %d images", tc.mode, tc.count)
		}
	}
}

func TestKlingPresetUsesNativeReferenceMarker(t *testing.T) {
	profile := ProviderProfile{Mode: "r2v", Model: "kwaivgi/kling-v3-omni-video", InputField: "reference_images"}
	input := GenerationInput{Mode: "r2v", Type: "video", Prompt: "@图片1 转身看向 @image2。",
		References: []GenerationReference{
			{Type: "image", URL: "https://example.com/first.png"},
			{Type: "image", URL: "https://example.com/second.png"},
		}}
	_, request, err := replicateRequest(profile, input)
	if err != nil || request.Input["prompt"] != "<<<image_1>>> 转身看向 <<<image_2>>>。" {
		t.Fatalf("Kling reference prompt: %+v %v", request, err)
	}
}
