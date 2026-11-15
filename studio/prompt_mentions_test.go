package studio

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/png"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestPromptMentionsReachMiniMaxR2VRequest(t *testing.T) {
	const (
		channelID = "h3-fixture"
		linkedURL = "https://assets.example.test/linked.png"
		videoURL  = "https://assets.example.test/clip.mp4"
		audioURL  = "https://assets.example.test/sound.wav"
		taskID    = "123456789"
	)
	settings, err := OpenProfileSettings("")
	if err != nil {
		t.Fatal(err)
	}
	modelID := uuid.NewString()
	settings.data.Channels = []VideoChannel{{ID: channelID, Name: "H3 fixture", Protocol: minimaxH3Protocol}}
	settings.data.Profiles = []ProviderProfile{{
		ID: modelID, Name: "H3 fixture", Model: minimaxH3Model, ChannelID: channelID, Modes: []string{"r2v"},
		Limits: VideoLimits{References: map[string]int{"image": 2, "video": 1, "audio": 1}, MaxReferences: 4},
	}}
	settings.data.Generation.DefaultModelID = modelID
	settings.data.Keys[channelID] = "fixture-key"

	dir := t.TempDir()
	linked, uploaded, video, audio, target := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	assetID := uuid.NewString() + ".png"
	path := "assets/images/" + assetID
	var pngBytes bytes.Buffer
	if err := png.Encode(&pngBytes, image.NewRGBA(image.Rect(0, 0, 256, 256))); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "assets", "images"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, path), pngBytes.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	service := New(settings)
	t.Cleanup(func() { _ = service.Close() })
	bindSession(t, service, dir, "a")
	service.SetHumanWriteCheck(func(context.Context, string, string, []string) (bool, error) { return true, nil })
	order := []string{linked}
	mustCall(t, service, dir, "a", "append", appendArgs{
		operation: operation{ID: "create"},
		Nodes: []NodeInput{
			{ID: linked, Type: "image", Content: encodeMentionFixture(t, map[string]string{"url": linkedURL})},
			{ID: uploaded, Type: "image", Content: encodeMentionFixture(t, map[string]string{
				"path": path, "assetId": assetID, "url": "https://assets.example.test/older.png",
			})},
			{ID: video, Type: "video", Content: encodeMentionFixture(t, map[string]string{"url": videoURL})},
			{ID: audio, Type: "audio", Content: encodeMentionFixture(t, map[string]string{"url": audioURL})},
			{ID: target, Type: "video", Content: encodeMentionFixture(t, map[string]any{
				"mode": "r2v", "prompt": "固定中景。", "mixedListOrder": order,
			})},
		},
		Edges: []Edge{{Source: linked, Target: target}},
	})
	imageMention := promptMentionPart(assetID, "image", "人物")
	mustEdit(t, service, dir, "a", "update_node", updateNodeArgs{
		nodeRevisionArgs: nodeRevisionArgs{operation: operation{ID: "save-prompt"}, ID: target, Revision: 1},
		Content: promptMentionContent(t, "r2v",
			docText("使用 "), promptMentionPart(audio, "audio", "环境声"),
			docText("，参考 "), promptMentionPart(linked, "image", "构图"),
			docText(" 和 "), promptMentionPart(video, "video", "动作"),
			docText("，切回 "), imageMention, docText("，保持 "), imageMention, docText("2秒。")),
		ReferenceSources: &order,
	})
	if err := service.Close(); err != nil {
		t.Fatal(err)
	}
	service = New(settings)
	result := mustCall(t, service, dir, "a", "query", queryArgs{ID: target}).(queryResult)
	if len(result.Nodes) != 1 || len(result.Edges) != 1 || result.Edges[0] != (Edge{Source: linked, Target: target}) {
		t.Fatalf("target or original canvas edge lost on reload: %+v", result)
	}
	for asset, node := range map[string]string{assetID: uploaded, linked: linked, video: video, audio: audio} {
		if got := result.MentionedAssets[asset].ID; got != node {
			t.Fatalf("mention %s resolves to %q, want %q", asset, got, node)
		}
	}

	var requests []string
	settings.client.Transport = arkFixtureTransport(func(req *http.Request) (*http.Response, error) {
		requests = append(requests, req.URL.Path)
		if req.URL.Host != "metaso.cn" || req.Method != http.MethodPost {
			return nil, fmt.Errorf("unexpected H3 request: %s %s", req.Method, req.URL)
		}
		switch req.URL.Path {
		case "/api/minimax" + minimaxH3Upload:
			minimaxVerifyUpload(t, req, pngBytes.Bytes())
			return arkFixtureResponse(http.StatusOK, `{"file":{"file_id":12345}}`)
		case "/api/minimax" + minimaxH3Submit:
			var body struct {
				Model   string           `json:"model"`
				Content []map[string]any `json:"content"`
			}
			if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			want := []map[string]any{
				{"type": "text", "text": "使用 @音频1，参考 @图片1 和 @视频1，切回 @图片2，保持 @图片2 2秒。"},
				minimaxFixtureContent("image", "reference_image", linkedURL),
				minimaxFixtureContent("audio", "reference_audio", audioURL),
				minimaxFixtureContent("video", "reference_video", videoURL),
				minimaxFixtureContent("image", "reference_image", "mm_file://12345"),
			}
			if body.Model != minimaxH3Model || !reflect.DeepEqual(body.Content, want) {
				t.Fatalf("H3 request: %+v, want content %+v", body, want)
			}
			return arkFixtureResponse(http.StatusOK, `{"task_id":"`+taskID+`"}`)
		default:
			return nil, fmt.Errorf("unexpected H3 request path: %s", req.URL.Path)
		}
	})
	mustCall(t, service, dir, "a", "generateR2V", map[string]any{
		"operationId": "generate", "nodeId": target, "confirmed": true,
	})
	p, err := service.open(context.Background(), dir, false)
	if err != nil {
		t.Fatal(err)
	}
	if err := p.advance(context.Background(), settings); err != nil {
		t.Fatal(err)
	}
	tasks := tasksIn(t, service, dir, "a")
	if len(tasks) != 1 || tasks[0].NodeID != target || tasks[0].ProviderTaskID != taskID || tasks[0].Status != "polling" ||
		!slices.Equal(requests, []string{"/api/minimax" + minimaxH3Upload, "/api/minimax" + minimaxH3Submit}) {
		t.Fatalf("expected one upload and submit for target %s, got requests %v, tasks %+v", target, requests, tasks)
	}
}

func TestPromptMentionsJoinGenerationSnapshotWithoutGraphMutation(t *testing.T) {
	dir := t.TempDir()
	s := New(providerFixture{})
	defer s.Close()
	bindSession(t, s, dir, "a")
	s.SetHumanWriteCheck(func(context.Context, string, string, []string) (bool, error) { return true, nil })
	frame, audio, draft := uuid.NewString(), uuid.NewString(), uuid.NewString()
	assetID := uuid.NewString() + ".png"
	imagePath := "assets/images/" + assetID
	audioURL := "https://assets.example.test/ambience.wav"
	if err := os.MkdirAll(filepath.Dir(filepath.Join(dir, imagePath)), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, imagePath), []byte("file fixture"), 0o600); err != nil {
		t.Fatal(err)
	}
	image := promptMentionPart(assetID, "image", "图片99")
	sound := promptMentionPart(audio, "audio", "雨声")
	content := promptMentionContent(t, "r2v", docText("沿用 "), image, docText(" 与 "), sound, docText("，再次使用 "), image)
	appended, err := editCall(s, dir, "a", "human", "append", appendArgs{
		operation: operation{ID: "create"},
		Nodes: []NodeInput{
			{ID: frame, Type: "image", Content: encodeMentionFixture(t, map[string]string{"path": imagePath, "assetId": assetID})},
			{ID: audio, Type: "audio", Content: encodeMentionFixture(t, map[string]string{"url": audioURL})},
			{ID: draft, Type: "video", Content: content},
		},
	})
	if err != nil || len(appended.(appendResult).IDs) != 3 {
		t.Fatalf("append: %v, %v", appended, err)
	}
	mustEdit(t, s, dir, "a", "delete_node", nodeRevisionArgs{operation: operation{ID: "delete-original-card"}, ID: frame, Revision: 1})
	result := mustCall(t, s, dir, "a", "query", queryArgs{ID: draft}).(queryResult)
	if len(result.Edges) != 0 || result.MentionedAssets[assetID].ID != frame || !result.MentionedAssets[assetID].Deleted ||
		result.MentionedAssets[audio].ID != audio || !strings.Contains(string(result.Nodes[0].Content), "沿用 @图片99 与 @雨声，再次使用 @图片99") {
		t.Fatalf("query: %+v", result)
	}
	request := map[string]any{"operationId": "generate", "nodeId": draft, "confirmed": true}
	mustCall(t, s, dir, "a", "generateR2V", request)
	p, err := s.open(context.Background(), dir, false)
	if err != nil {
		t.Fatal(err)
	}
	var raw string
	if err := p.db.QueryRow("SELECT input FROM tasks WHERE node_id=?", draft).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var generation generationRequest
	if err := json.Unmarshal([]byte(raw), &generation); err != nil {
		t.Fatal(err)
	}
	want := []GenerationReference{{Type: "image", Path: imagePath}, {Type: "audio", URL: audioURL}}
	if generation.Prompt != "沿用 @图片1 与 @音频1，再次使用 @图片1" || !slices.Equal(generation.References, want) ||
		!slices.Equal(generation.SourceNodeIDs, []string{frame, audio}) {
		t.Fatalf("unexpected generated input: %+v", generation)
	}
	after := mustCall(t, s, dir, "a", "query", nil).(queryResult)
	if len(after.Nodes) != 2 || len(after.Edges) != 0 || !slices.Contains(after.LockedNodeIDs, audio) {
		t.Fatalf("unexpected graph changes or dependency locks: %+v", after)
	}
}

func TestPromptMentionsPreserveLegacySlotsAndValidateMissingOrIncompatible(t *testing.T) {
	for _, variant := range []struct {
		name, mode, kind, assetURL, graph, expectedError string
	}{
		{name: "I2V same connected image", mode: "i2v", kind: "image", assetURL: "https://assets.example.test/frame.png", graph: "image"},
		{name: "I2V mention becomes tail frame", mode: "i2v", kind: "image", assetURL: "https://assets.example.test/tail.png", graph: "other"},
		{name: "V2V source video", mode: "v2v", kind: "video", assetURL: "https://assets.example.test/source.mp4"},
		{name: "T2V incompatible", mode: "t2v", kind: "image", assetURL: "https://assets.example.test/frame.png", expectedError: "T2V 只接受"},
		{name: "Unregistered asset", mode: "i2v", kind: "image", expectedError: "不存在"},
	} {
		t.Run(variant.name, func(t *testing.T) {
			dir := t.TempDir()
			s := New(providerFixture{})
			defer s.Close()
			bindSession(t, s, dir, "a")
			asset, draft, linked := uuid.NewString(), uuid.NewString(), uuid.NewString()
			parts := []map[string]any{docText("使用 "), promptMentionPart(asset, variant.kind, "已选素材")}
			args := appendArgs{operation: operation{ID: "create"}}
			if variant.assetURL != "" {
				args.Nodes = append(args.Nodes, NodeInput{ID: asset, Type: variant.kind,
					Content: encodeMentionFixture(t, map[string]string{"url": variant.assetURL})})
			}
			content := promptMentionContent(t, variant.mode, parts...)
			if variant.graph != "" {
				if variant.graph == "image" {
					linked = asset
				} else {
					args.Nodes = append(args.Nodes, NodeInput{ID: linked, Type: "image",
						Content: json.RawMessage(`{"url":"https://assets.example.test/frame.png"}`)})
				}
				args.Edges = []Edge{{linked, draft}}
			}
			args.Nodes = append(args.Nodes, NodeInput{ID: draft, Type: "video", Content: content})
			if _, err := editCall(s, dir, "a", "human", "append", args); err != nil {
				t.Fatalf("draft save: %v", err)
			}
			request := map[string]any{"operationId": "generate", "nodeId": draft, "confirmed": true}
			_, err := call(s, dir, "a", "submit_manual", request)
			if variant.expectedError != "" {
				if err == nil || !strings.Contains(err.Error(), variant.expectedError) {
					t.Fatalf("submission = %v, expected %s", err, variant.expectedError)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			p, err := s.open(context.Background(), dir, false)
			if err != nil {
				t.Fatal(err)
			}
			var raw string
			if err := p.db.QueryRow("SELECT input FROM tasks WHERE node_id=?", draft).Scan(&raw); err != nil {
				t.Fatal(err)
			}
			var generation generationRequest
			if err := json.Unmarshal([]byte(raw), &generation); err != nil {
				t.Fatal(err)
			}
			want := []GenerationReference{{Type: variant.kind, URL: variant.assetURL}}
			prompt := "使用 @" + assetMentionLabels[variant.kind] + "1"
			if variant.graph == "other" {
				want = append([]GenerationReference{{Type: "image", URL: "https://assets.example.test/frame.png"}}, want...)
				prompt = "使用 @图片2"
			}
			if generation.Prompt != prompt || !slices.Equal(generation.References, want) {
				t.Fatalf("unexpected generated input: %+v", generation)
			}
		})
	}
}

func TestPromptMentionRejectsTextAtomAndInvalidPath(t *testing.T) {
	dir := t.TempDir()
	s := New(nil)
	defer s.Close()
	bindSession(t, s, dir, "a")
	for _, part := range []map[string]any{
		promptMentionPart(uuid.NewString(), "note", "文字"),
		promptMentionPart("../../other-project/frame.png", "image", "图片"),
	} {
		_, err := editCall(s, dir, "a", "human", "append", appendArgs{
			operation: operation{ID: uuid.NewString()},
			Nodes:     []NodeInput{{Type: "video", Content: promptMentionContent(t, "r2v", part)}},
		})
		if err == nil {
			t.Fatalf("invalid mention accepted: %v", part)
		}
	}
}

func TestPromptMentionNoteAndSelfReference(t *testing.T) {
	dir := t.TempDir()
	s := New(providerFixture{})
	defer s.Close()
	bindSession(t, s, dir, "a")
	image, note := uuid.NewString(), uuid.NewString()
	part := promptMentionPart(image, "image", "舞台")
	noteContent := map[string]any{
		"text": "参考 @舞台",
		"promptDoc": map[string]any{"type": "doc", "content": []any{
			map[string]any{"type": "paragraph", "content": []any{docText("参考 "), part}},
		}},
	}
	imageContent := map[string]any{
		"url":       "https://assets.example.test/stage.png",
		"promptDoc": noteContent["promptDoc"],
	}
	if _, err := editCall(s, dir, "a", "human", "append", appendArgs{
		operation: operation{ID: "create"},
		Nodes: []NodeInput{
			{ID: image, Type: "image", Content: encodeMentionFixture(t, imageContent)},
			{ID: note, Type: "prompt", Content: encodeMentionFixture(t, noteContent)},
		},
	}); err != nil {
		t.Fatal(err)
	}
	result := mustCall(t, s, dir, "a", "query", queryArgs{ID: note}).(queryResult)
	if len(result.Edges) != 0 || result.MentionedAssets[image].ID != image || nodeText(result.Nodes[0].Content) != "参考 @舞台" {
		t.Fatalf("note lost structured or plain prompt: %+v", result)
	}
	request := map[string]any{"operationId": "generate", "nodeId": image, "confirmed": true}
	if _, err := call(s, dir, "a", "submit_manual", request); err == nil || !strings.Contains(err.Error(), "自身") {
		t.Fatalf("self-referencing generation accepted: %v", err)
	}
}

func encodeMentionFixture(t *testing.T, fixture any) json.RawMessage {
	t.Helper()
	data, err := json.Marshal(fixture)
	if err != nil {
		t.Fatal(err)
	}
	return json.RawMessage(data)
}

func promptMentionContent(t *testing.T, mode string, parts ...map[string]any) json.RawMessage {
	t.Helper()
	return encodeMentionFixture(t, map[string]any{
		"mode": mode, "prompt": "old plain fallback",
		"promptDoc": map[string]any{"type": "doc", "content": []any{map[string]any{"type": "paragraph", "content": parts}}},
	})
}

func docText(text string) map[string]any {
	return map[string]any{"type": "text", "text": text}
}

func promptMentionPart(id, kind, label string) map[string]any {
	return map[string]any{"type": "assetMention", "attrs": assetMention{AssetID: id, AssetType: kind, Label: label}}
}
