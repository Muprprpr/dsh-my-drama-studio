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

func TestLegacyProviderSettingsImportAndRedaction(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "providers.dpapi")
	settings, err := OpenProfileSettings(path)
	if err != nil {
		t.Fatal(err)
	}
	const key = "fixture-not-a-live-provider-token"
	profile := ProviderProfile{ID: uuid.NewString(), Name: "Veo Reference", Provider: "replicate", Mode: "r2v", Model: "google/veo-3.1", InputField: "reference_images"}
	document, err := json.Marshal(providerData{Profiles: []ProviderProfile{profile},
		Keys: map[string]string{"replicate": key}, Defaults: map[string]string{"r2v": profile.ID}})
	if err != nil {
		t.Fatal(err)
	}
	encrypted, err := providerSecret(document, true)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, encrypted, 0o600); err != nil {
		t.Fatal(err)
	}
	imported, err := settings.execute(ctx, "provider_legacy", nil)
	if err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(imported)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := settings.execute(ctx, "provider_configure", payload); err != nil {
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
	settings.data.Profiles = nil
	if _, err := settings.Resolve(input.Profile); err != nil {
		t.Fatal("Preset removal must preserve credentials for queued tasks:", err)
	}
	if err := settings.Prepare(&input, ""); err == nil {
		t.Fatal("Removed preset selected for a new task")
	}
}

func TestConfiguredProviderJobKeepsPresetAcrossEdits(t *testing.T) {
	ctx := context.Background()
	settings, err := OpenProfileSettings("")
	if err != nil {
		t.Fatal(err)
	}
	const token = "fixture-token"
	initial := ProviderProfile{ID: uuid.NewString(), Name: "Wan Text", Provider: "replicate",
		ChannelID: "replicate", Modes: []string{"t2v"}, Model: "wan-video/wan-2.7-t2v"}
	settings.data.Profiles = []ProviderProfile{initial}
	settings.data.Channels = []VideoChannel{{ID: "replicate", Name: "Replicate", Protocol: "replicate"}}
	settings.data.Keys["replicate"] = token
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
			body = string(protocolTestVideo)
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
	settings.data.Profiles[0].Model = "google/veo-3.1"
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
