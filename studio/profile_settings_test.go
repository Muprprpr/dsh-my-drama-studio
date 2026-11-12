package studio

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestProfileSettingsPlan(t *testing.T) {
	ctx := context.Background()
	settings, err := OpenProfileSettings("")
	if err != nil {
		t.Fatal(err)
	}
	plan := func(config providerData, action string, data any) (settingsPlan, error) {
		t.Helper()
		raw, err := json.Marshal(map[string]any{"config": config, "action": action, "data": data})
		if err != nil {
			t.Fatal(err)
		}
		value, err := settings.execute(ctx, "provider_plan", raw)
		if err != nil {
			return settingsPlan{}, err
		}
		return value.(settingsPlan), nil
	}
	current, err := plan(providerData{}, "channel_save", map[string]any{"channel": VideoChannel{
		Name: "Gateway", Protocol: "openai-video", BaseURL: "https://gateway.example/v1/",
	}})
	if err != nil || current.ChannelID == "" || current.Config.Generation.MaxConcurrent != 2 {
		t.Fatalf("create channel: %#v %v", current, err)
	}
	id := current.ChannelID
	channel := current.Config.Channels[0]
	channel.Name = "Renamed gateway"
	current, err = plan(current.Config, "channel_save", map[string]any{"channel": channel})
	if err != nil || current.Config.Channels[0].Name != channel.Name {
		t.Fatalf("update channel: %#v %v", current, err)
	}
	for _, model := range []string{"fixture-one", "fixture-two"} {
		current, err = plan(current.Config, "provider_save", map[string]any{"profile": ProviderProfile{
			ChannelID: id, Name: model, Model: model, Modes: []string{"t2v", "i2v"},
		}})
		if err != nil {
			t.Fatal(err)
		}
	}
	badDimensions := ProviderProfile{ChannelID: id, Name: "Wrong dimensions", Model: "fixture-bad",
		Modes: []string{"t2v"}, Defaults: VideoParams{Resolution: "1280x720", AspectRatio: "9:16"}}
	if _, err := plan(current.Config, "provider_save", map[string]any{"profile": badDimensions}); err == nil ||
		!strings.Contains(err.Error(), "画幅与分辨率不匹配") {
		t.Fatalf("inconsistent preset dimensions should be rejected at save: %v", err)
	}
	if _, err := plan(current.Config, "channel_remove", map[string]string{"id": id}); err == nil {
		t.Fatal("removed a channel with attached model presets")
	}
	raw, err := json.Marshal(map[string]any{"config": current.Config, "keys": map[string]string{id: "secret-fixture"}})
	if err != nil {
		t.Fatal(err)
	}
	view, err := settings.execute(ctx, "provider_configure", raw)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(view)
	if err != nil || strings.Contains(string(encoded), "secret-fixture") || !strings.Contains(string(encoded), `"configured":true`) {
		t.Fatalf("unsafe or incorrect settings projection: %s (%v)", encoded, err)
	}
	for _, profile := range current.Config.Profiles {
		current, err = plan(current.Config, "provider_remove", map[string]string{"id": profile.ID})
		if err != nil {
			t.Fatal(err)
		}
	}
	current, err = plan(current.Config, "channel_remove", map[string]string{"id": id})
	if err != nil || len(current.Config.Channels) != 0 || len(current.Config.Retired) != 1 {
		t.Fatalf("delete channel: %#v %v", current, err)
	}
}

func TestVideoCompletionEvidenceUsesSubmittingCredential(t *testing.T) {
	settings, err := OpenProfileSettings("")
	if err != nil {
		t.Fatal(err)
	}
	channel := VideoChannel{ID: "channel", Name: "Gateway", Protocol: "openai-video", BaseURL: "https://video.example.com"}
	profile := ProviderProfile{ID: "preset", ChannelID: channel.ID, Channel: &channel, Provider: channel.Protocol,
		Model: "fixture-video", Mode: "t2v"}
	configure := func(key string) {
		t.Helper()
		raw, err := json.Marshal(map[string]any{
			"config": providerData{Channels: []VideoChannel{channel}},
			"keys":   map[string]string{channel.ID: key},
		})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := settings.execute(context.Background(), "provider_configure", raw); err != nil {
			t.Fatal(err)
		}
	}
	complete := func() func() {
		t.Helper()
		resolved, err := settings.Resolve(profile)
		if err != nil {
			t.Fatal(err)
		}
		return resolved.(*resolvedChannelProvider).onCompleted
	}
	status := func() string { return settings.view()["channels"].([]channelView)[0].Verification.TaskSucceeded }
	configure("first-fixture-key")
	lateCompletion := complete()
	complete()()
	if status() != "verified" {
		t.Fatal("a completed task with the current credential must verify the channel")
	}
	configure("second-fixture-key")
	lateCompletion()
	if status() == "verified" {
		t.Fatal("the previous credential must not verify the channel after rotation")
	}
	complete()()
	if status() != "verified" {
		t.Fatal("a completed task with the replacement credential must verify the channel")
	}
}
