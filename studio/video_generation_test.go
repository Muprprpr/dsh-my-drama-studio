package studio

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestVideoSubmissionDistinguishesUnsetModeFromLegacyMode(t *testing.T) {
	dir := t.TempDir()
	s := New(providerFixture{})
	defer s.Close()
	bindSession(t, s, dir, "a")
	s.SetHumanWriteCheck(func(context.Context, string, string, []string, []string) (bool, error) { return true, nil })
	unset, legacy := uuid.NewString(), uuid.NewString()
	const prompt = "A smooth camera move."
	_, err := editCall(s, dir, "a", "human", "append", appendArgs{
		operation: operation{ID: "append-video-modes"},
		Nodes: []NodeInput{
			{ID: unset, Type: "video", Content: json.RawMessage(`{"mode":"","prompt":"` + prompt + `"}`)},
			{ID: legacy, Type: "video", Content: json.RawMessage(`{"prompt":"` + prompt + `"}`)},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, action := range []string{"submit_manual", "generateT2V"} {
		request := map[string]any{"operationId": "unset-" + action, "nodeId": unset, "confirmed": true}
		if _, err := call(s, dir, "a", action, request); err == nil || !strings.Contains(err.Error(), "选择视频生成方式") {
			t.Fatalf("%s with unset mode returned %v", action, err)
		}
	}
	if tasks := tasksIn(t, s, dir, "a"); len(tasks) != 0 {
		t.Fatalf("unset mode created tasks: %+v", tasks)
	}
	mustCall(t, s, dir, "a", "generateT2V",
		map[string]any{"operationId": "legacy-mode", "nodeId": legacy, "confirmed": true})
	mustEdit(t, s, dir, "a", "update_node", updateNodeArgs{
		nodeRevisionArgs: nodeRevisionArgs{operation: operation{ID: "select-mode"}, ID: unset, Revision: 1},
		Content:          json.RawMessage(`{"mode":"t2v","prompt":"` + prompt + `"}`),
	})
	mustCall(t, s, dir, "a", "generateT2V",
		map[string]any{"operationId": "chosen-mode", "nodeId": unset, "confirmed": true})
	tasks := tasksIn(t, s, dir, "a")
	if len(tasks) != 2 || tasks[0].NodeID != unset || tasks[0].Mode != "t2v" ||
		tasks[1].NodeID != legacy || tasks[1].Mode != "t2v" {
		t.Fatalf("unexpected submitted modes: %+v", tasks)
	}
}

func TestVideoGenerationEntryPointsAndSnapshots(t *testing.T) {
	channel := VideoChannel{ID: "fixture", Name: "Fixture", Protocol: "custom-rest", BaseURL: "https://fixture.example", Advanced: &CustomREST{
		SubmitURL: "/jobs", SubmitMethod: "POST", Auth: "none", QueryURL: "/jobs/{taskId}", TaskIDPath: "id",
		StatusPath: "status", OutputURLPath: "output", StatusMap: map[string]string{"success": "completed", "error": "failed"},
		Fields: map[string]string{"duration": "duration", "firstFrame": "first", "lastFrame": "last", "references": "refs", "sourceVideo": "source"},
	}}
	model := ProviderProfile{
		ID: uuid.NewString(), Name: "Fixture video", Model: "video-fixture", ChannelID: channel.ID,
		Modes: []string{"t2v", "i2v", "r2v", "v2v"}, Defaults: VideoParams{Duration: 5},
		Limits: VideoLimits{Durations: []int{4, 5, 8}, LastFrame: true, References: map[string]int{"image": 1, "video": 1, "audio": 1}, MaxReferences: 3},
	}
	settings, err := OpenProfileSettings("")
	if err != nil {
		t.Fatal(err)
	}
	settings.data.Channels, settings.data.Profiles = []VideoChannel{channel}, []ProviderProfile{model}
	settings.data.Generation.DefaultModelID = model.ID
	settings.data.Generation.VideoParams = VideoParams{Duration: 4, Resolution: "1080p", AspectRatio: "16:9"}
	service := New(settings)
	defer service.Close()
	dir := t.TempDir()
	bindSession(t, service, dir, "a")
	image, tail, video, audio := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	mustCall(t, service, dir, "a", "append", appendArgs{operation: operation{ID: "assets"}, Nodes: []NodeInput{
		{ID: image, Type: "image", Content: json.RawMessage(`{"path":"assets/images/frame.png"}`)},
		{ID: tail, Type: "image", Content: json.RawMessage(`{"path":"assets/images/tail.png"}`)},
		{ID: video, Type: "video", Content: json.RawMessage(`{"path":"assets/previous/source.mp4"}`)},
		{ID: audio, Type: "audio", Content: json.RawMessage(`{"path":"assets/audio/reference.wav"}`)},
	}})
	for _, tc := range []struct {
		action, mode, prompt string
		refs, kinds          []string
		duration             int
	}{
		{"generateT2V", "t2v", "A smooth camera move.", nil, nil, 5},
		{"generateI2V", "i2v", "Transition from @图片1 to @图片2.", []string{image, tail}, []string{"image", "image"}, 5},
		{"generateR2V", "r2v", "Use @视频1, @图片1 and @音频1.", []string{video, image, audio}, []string{"video", "image", "audio"}, 8},
		{"generateV2V", "v2v", "Reframe @视频1.", []string{video}, []string{"video"}, 5},
	} {
		t.Run(tc.mode, func(t *testing.T) {
			nodeID := uuid.NewString()
			content := map[string]any{"mode": tc.mode, "prompt": tc.prompt, "mixedListOrder": tc.refs}
			if tc.duration == 8 {
				content["params"] = VideoParams{Duration: 8}
			}
			raw, _ := json.Marshal(content)
			var edges []Edge
			for _, id := range tc.refs {
				edges = append(edges, Edge{Source: id, Target: nodeID})
			}
			mustCall(t, service, dir, "a", "append", appendArgs{operation: operation{ID: "draft-" + tc.mode},
				Nodes: []NodeInput{{ID: nodeID, Type: "video", Content: raw}}, Edges: edges})
			action := map[string]any{"operationId": "generate-" + tc.mode, "nodeId": nodeID, "confirmed": true}
			mustCall(t, service, dir, "a", tc.action, action)
			var snapshot string
			for _, project := range service.projects {
				if err := project.db.QueryRow("SELECT input FROM tasks WHERE node_id=?", nodeID).Scan(&snapshot); err != nil {
					t.Fatal(err)
				}
			}
			var input GenerationInput
			if err := json.Unmarshal([]byte(snapshot), &input); err != nil {
				t.Fatal(err)
			}
			var kinds []string
			for _, ref := range input.References {
				kinds = append(kinds, ref.Type)
			}
			if input.Mode != tc.mode || input.Prompt != tc.prompt || !reflect.DeepEqual(kinds, tc.kinds) ||
				input.Profile.Model != model.Model || input.Profile.ChannelID != channel.ID ||
				input.Params != (VideoParams{Duration: tc.duration}) {
				t.Fatalf("unexpected request snapshot: %+v", input)
			}
			if tc.mode != "t2v" {
				action["operationId"] = "wrong-" + tc.mode
				if _, err := call(service, dir, "a", "generateT2V", action); err == nil || !strings.Contains(err.Error(), "不匹配") {
					t.Fatalf("mode downgrade was not rejected: %v", err)
				}
			}
		})
	}
	if settings.data.Generation.Duration != 4 || settings.data.Profiles[0].Defaults.Duration != 5 {
		t.Fatal("per-node override changed profile configuration")
	}
}

func TestVideoModelCapsRejectExplicitUnsupportedOverrides(t *testing.T) {
	profile := ProviderProfile{Provider: "custom-rest", Limits: VideoLimits{Durations: []int{4, 8}},
		Channel: &VideoChannel{Protocol: "custom-rest", Advanced: &CustomREST{Fields: map[string]string{"duration": "seconds"}}}}
	enabled := true
	for _, params := range []VideoParams{{Duration: 9}, {Resolution: "720p"}, {AspectRatio: "1:1"}, {GenerateAudio: &enabled}} {
		if _, err := resolveVideoParams(profile, VideoParams{}, params); err == nil {
			t.Fatalf("allowed unsupported node override: %+v", params)
		}
	}
	params, err := resolveVideoParams(profile, VideoParams{Duration: 8, Resolution: "720p", GenerateAudio: &enabled}, VideoParams{})
	if err != nil || params != (VideoParams{Duration: 8}) {
		t.Fatalf("unsupported global parameters leaked: %+v, %v", params, err)
	}
}

func TestMiniMaxI2VInheritsFirstFrameRatio(t *testing.T) {
	profile := ProviderProfile{Provider: minimaxH3Protocol, Channel: &VideoChannel{Protocol: minimaxH3Protocol},
		Defaults: VideoParams{Duration: 4, Resolution: "768P", AspectRatio: "16:9"},
		Limits:   VideoLimits{AspectRatios: []string{"16:9", "9:16"}}}
	for _, tc := range []struct{ mode, ratio string }{{"i2v", ""}, {"t2v", "9:16"}} {
		input := GenerationInput{Mode: tc.mode, Params: VideoParams{AspectRatio: "9:16"}}
		if err := prepareVideoGeneration(&input, &profile, VideoParams{AspectRatio: "16:9"}); err != nil {
			t.Fatal(err)
		}
		if want := (VideoParams{Duration: 4, Resolution: "768P", AspectRatio: tc.ratio}); input.Params != want {
			t.Fatalf("%s params = %+v, want %+v", tc.mode, input.Params, want)
		}
	}
	if profile.Defaults.AspectRatio != "16:9" || len(profile.Limits.AspectRatios) != 2 {
		t.Fatal("mode-specific ratio resolution modified the shared preset")
	}
}
