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
	order := []string{linked, audio, video, uploaded}
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
		Edges: []Edge{{Source: linked, Target: target}, {Source: audio, Target: target},
			{Source: video, Target: target}, {Source: uploaded, Target: target}},
	})
	imageMention := promptMentionPart(assetID, "image", "人物")
	mustEdit(t, service, dir, "a", "update_node", updateNodeArgs{
		nodeRevisionArgs: nodeRevisionArgs{operation: operation{ID: "save-prompt"}, ID: target, Revision: 1},
		Content: promptMentionContent(t, "r2v", "  使用 @环境声，参考 @构图 和 @动作，切回 @人物，保持 @人物2秒。\n尾部限制：保留人声。  ",
			docText("  使用 "), promptMentionPart(audio, "audio", "环境声"),
			docText("，参考 "), promptMentionPart(linked, "image", "构图"),
			docText(" 和 "), promptMentionPart(video, "video", "动作"),
			docText("，切回 "), imageMention, docText("，保持 "), imageMention, docText("2秒。\n尾部限制：保留人声。  ")),
		ReferenceSources: &order,
	})
	if err := service.Close(); err != nil {
		t.Fatal(err)
	}
	service = New(settings)
	result := mustCall(t, service, dir, "a", "query", queryArgs{ID: target}).(queryResult)
	if len(result.Nodes) != 1 || len(result.Edges) != len(order) || result.Edges[0] != (Edge{Source: linked, Target: target}) {
		t.Fatalf("target or original canvas edge lost on reload: %+v", result)
	}
	if len(result.MentionedAssets) != 0 || len(result.InvalidMedia) != 0 {
		t.Fatalf("target projected detached mentions or reported invalid media: %+v", result)
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
				{"type": "text", "text": "  使用 音频 1，参考 图片 1 和 视频 1，切回 图片 2，保持 图片 2 2秒。\n尾部限制：保留人声。  "},
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

func TestVideoInputRulesReachMiniMaxHTTP(t *testing.T) {
	const aURL = "https://assets.example.test/a.png"
	const bURL = "https://assets.example.test/b.png"
	const literal = "  镜头推进。\n角色说：“保持原声。” 字面文本 @图片1，联系 film@image1.example。\n尾部限制：保留停顿。  "
	for _, tc := range []struct {
		name, mode, prompt, doc, change, wantError string
		sources                                    string
		automatic                                  bool
		wantMedia                                  []map[string]any
	}{
		{name: "T01 zero edge and plain email", mode: "t2v", prompt: literal, automatic: true},
		{name: "T02 detached image and audio doc", mode: "t2v", prompt: literal, doc: "stale"},
		{name: "T03 active image without edge", mode: "t2v", prompt: "参考 @图B", doc: "image", wantError: "图B"},
		{name: "T03 active audio without edge", mode: "t2v", prompt: "参考 @环境声", doc: "audio", wantError: "环境声"},
		{name: "T04 long plain authority", mode: "t2v", prompt: strings.Repeat("台词：“直到最后。”\n", 160) + literal, doc: "pure"},
		{name: "T05 only edge A, stale B", mode: "r2v", prompt: literal, doc: "stale", sources: "A",
			wantMedia: []map[string]any{minimaxFixtureContent("image", "reference_image", aURL)}},
		{name: "T05 only edge A, active B", mode: "r2v", prompt: "参考 @图B", doc: "image", sources: "A", wantError: "图B"},
		{name: "T06 deleted card with URL and file", mode: "r2v", prompt: "参考 @图B", doc: "image", sources: "B", change: "delete", wantError: "图B"},
		{name: "T06 disconnected card", mode: "r2v", prompt: "参考 @图B", doc: "image", sources: "B", change: "disconnect", wantError: "图B"},
		{name: "T06 connected file is missing", mode: "r2v", prompt: literal, sources: "B", change: "file-missing", wantError: "项目文件"},
		{name: "T07 copied stale doc", mode: "t2v", prompt: literal, doc: "stale", change: "copy"},
		{name: "T08 legacy note edge and basedOn", mode: "t2v", prompt: literal, change: "legacy-text"},
		{name: "T09 no first frame", mode: "i2v", prompt: literal, wantError: "需要首帧"},
		{name: "T09 no source video", mode: "v2v", prompt: literal, wantError: "需要一个源视频"},
		{name: "T09 too many images for profile", mode: "r2v", prompt: literal, sources: "ABC", wantError: "参考"},
		{name: "T09 source type unsupported by profile", mode: "r2v", prompt: literal, sources: "D", wantError: "参考"},
		{name: "T09 T2V cannot discard edges", mode: "t2v", prompt: literal, change: "legacy-media", wantError: "T2V 只接受"},
		{name: "T10 same URL in two frame roles", mode: "i2v", prompt: literal, sources: "CA",
			wantMedia: []map[string]any{minimaxFixtureContent("image", "first_frame", aURL), minimaxFixtureContent("image", "last_frame", aURL)}},
		{name: "T11 T12 stale expected revision", mode: "t2v", prompt: literal, change: "conflict", wantError: "节点已更新"},
		{name: "T11 newly saved prompt", mode: "t2v", prompt: literal, change: "saved"},
		{name: "explicitly linked doc disagrees with prompt", mode: "t2v", prompt: literal, doc: "mismatch", wantError: "不一致"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			dir := t.TempDir()
			settings := miniMaxInputFixture(t)
			service := New(settings)
			t.Cleanup(func() { _ = service.Close() })
			bindSession(t, service, dir, "a")
			service.SetHumanWriteCheck(func(context.Context, string, string, []string) (bool, error) { return true, nil })
			project, err := service.open(ctx, dir, false)
			if err != nil {
				t.Fatal(err)
			}
			draft, a, b, c, audio, note := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
			const relative = "assets/images/b.png"
			if err := os.MkdirAll(filepath.Join(dir, "assets", "images"), 0o700); err != nil {
				t.Fatal(err)
			}
			if tc.change != "file-missing" {
				if err := os.WriteFile(filepath.Join(dir, relative), []byte("fixture image"), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			base := note
			if tc.change == "copy" {
				base = uuid.NewString()
			}
			bMention := promptMentionPart(b, "image", "图B")
			audioMention := promptMentionPart(audio, "audio", "环境声")
			var contentParts []map[string]any
			switch tc.doc {
			case "image", "mismatch":
				contentParts = []map[string]any{docText("参考 "), bMention}
			case "audio":
				contentParts = []map[string]any{docText("参考 "), audioMention}
			case "stale":
				contentParts = []map[string]any{docText("旧文 "), bMention, audioMention}
			case "pure":
				contentParts = []map[string]any{docText("完全不同的旧文")}
			}
			raw := promptMentionContent(t, tc.mode, tc.prompt, contentParts...)
			if tc.doc == "mismatch" {
				var fields map[string]any
				_ = json.Unmarshal(raw, &fields)
				fields["promptDocLinked"] = true
				raw = encodeMentionFixture(t, fields)
			}
			nodes := []NodeInput{
				{ID: a, Type: "image", Content: encodeMentionFixture(t, map[string]string{"url": aURL})},
				{ID: b, Type: "image", Content: encodeMentionFixture(t, map[string]string{"url": bURL, "path": relative, "thumbnail": bURL})},
				{ID: c, Type: "image", Content: encodeMentionFixture(t, map[string]string{"url": aURL})},
				{ID: audio, Type: "audio", Content: json.RawMessage(`{"url":"https://assets.example.test/rain.wav"}`)},
				{ID: note, Type: "prompt", Content: json.RawMessage(`{"text":"外部台词不可拼入视频正文"}`)},
			}
			if tc.change == "copy" {
				nodes = append(nodes, NodeInput{ID: base, Type: "video", Content: raw})
			}
			nodes = append(nodes, NodeInput{ID: draft, Type: "video", BasedOn: base, Content: raw})
			var edges []Edge
			var expectedSources []string
			for _, code := range tc.sources {
				source := map[rune]string{'A': a, 'B': b, 'C': c, 'D': audio}[code]
				edges = append(edges, Edge{source, draft})
				expectedSources = append(expectedSources, source)
			}
			if _, err := editCall(service, dir, "a", "human", "append", appendArgs{
				operation: operation{ID: "create"}, Nodes: nodes, Edges: edges,
			}); err != nil {
				t.Fatal(err)
			}
			request := map[string]any{"operationId": "submit", "nodeId": draft, "confirmed": true, "expectedRevision": 1}
			wanted := tc.prompt
			switch tc.change {
			case "delete":
				mustEdit(t, service, dir, "a", "delete_node", nodeRevisionArgs{operation: operation{ID: "delete"}, ID: b, Revision: 1})
				delete(request, "expectedRevision")
				if _, err := os.Stat(filepath.Join(dir, relative)); err != nil {
					t.Fatal("deleting the card removed its media:", err)
				}
			case "disconnect":
				mustEdit(t, service, dir, "a", "delete_edge", changeEdgeArgs{operation: operation{ID: "disconnect"}, Source: b, Target: draft, Revision: 1})
				delete(request, "expectedRevision")
			case "legacy-text", "legacy-media":
				source := note
				if tc.change == "legacy-media" {
					source = a
				}
				if _, err := project.db.Exec("INSERT INTO edges(source,target) VALUES(?,?)", source, draft); err != nil {
					t.Fatal(err)
				}
			case "saved", "conflict":
				wanted = tc.prompt + "\n现在改成推轨。"
				mustEdit(t, service, dir, "a", "update_node", updateNodeArgs{
					nodeRevisionArgs: nodeRevisionArgs{operation: operation{ID: "save"}, ID: draft, Revision: 1},
					Content:          promptMentionContent(t, tc.mode, wanted),
				})
				if tc.change == "saved" {
					request["expectedRevision"] = 2
				}
			}
			readback := mustCall(t, service, dir, "a", "query", queryArgs{ID: draft}).(queryResult)
			var stored struct {
				Prompt   string
				TextList []string
			}
			if err := json.Unmarshal(readback.Nodes[0].Content, &stored); err != nil || stored.Prompt != wanted || len(stored.TextList) > 0 {
				t.Fatalf("stored raw draft = %s (%v), want %q", readback.Nodes[0].Content, err, wanted)
			}
			if tc.change == "file-missing" && !strings.Contains(readback.InvalidMedia[b], "项目文件") {
				t.Fatalf("readback lost missing file diagnostic: %+v", readback.InvalidMedia)
			}
			var httpCalls int
			settings.client.Transport = arkFixtureTransport(func(req *http.Request) (*http.Response, error) {
				httpCalls++
				if tc.wantError != "" || req.URL.Path != "/api/minimax"+minimaxH3Submit || req.Method != "POST" {
					t.Fatalf("unexpected HTTP call %s %s", req.Method, req.URL.Path)
				}
				var body struct {
					Content []map[string]any
				}
				if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
					t.Fatal(err)
				}
				expected := append([]map[string]any{{"type": "text", "text": wanted}}, tc.wantMedia...)
				if !reflect.DeepEqual(body.Content, expected) {
					t.Fatalf("HTTP request content = %#v, want %#v", body.Content, expected)
				}
				return arkFixtureResponse(http.StatusOK, `{"task_id":"123456"}`)
			})
			action := "submit_manual"
			if tc.automatic {
				enabled := true
				mustCall(t, service, dir, "a", "permission", map[string]any{"operationId": "enable", "enabled": enabled})
				action = "submit"
				delete(request, "confirmed")
			}
			_, err = call(service, dir, "a", action, request)
			if tc.wantError != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantError) || len(tasksIn(t, service, dir, "a")) != 0 {
					t.Fatalf("submit = %v, want %q with no tasks", err, tc.wantError)
				}
				if err := project.advance(ctx, settings); err != nil || httpCalls != 0 {
					t.Fatalf("rejected draft reached channel: %d, %v", httpCalls, err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			var saved string
			if err := project.db.QueryRow("SELECT input FROM tasks WHERE node_id=?", draft).Scan(&saved); err != nil {
				t.Fatal(err)
			}
			var snapshot generationRequest
			if err := json.Unmarshal([]byte(saved), &snapshot); err != nil || snapshot.Prompt != wanted ||
				snapshot.VideoInputContract != videoInputContractVersion || len(snapshot.PromptMentions) != 0 ||
				!slices.Equal(snapshot.SourceNodeIDs, expectedSources) || len(snapshot.References) != len(expectedSources) {
				t.Fatalf("wrong frozen snapshot %s (%v)", saved, err)
			}
			for i, ref := range snapshot.References {
				if ref.SourceNodeID != expectedSources[i] || ref.SourceRevision != 1 ||
					ref.Role != tc.wantMedia[i]["role"] {
					t.Fatalf("wrong source or role in %s", saved)
				}
			}
			if err := project.advance(ctx, settings); err != nil || httpCalls != 1 {
				t.Fatalf("worker sent %d requests: %v, tasks %+v", httpCalls, err, tasksIn(t, service, dir, "a"))
			}
		})
	}
}

func miniMaxInputFixture(t *testing.T) *ProviderSettings {
	t.Helper()
	settings, err := OpenProfileSettings("")
	if err != nil {
		t.Fatal(err)
	}
	channelID := "h3"
	modelID := uuid.NewString()
	settings.data.Channels = []VideoChannel{{ID: channelID, Name: "H3 fixture", Protocol: minimaxH3Protocol}}
	settings.data.Profiles = []ProviderProfile{{
		ID: modelID, Name: "H3 fixture", Model: minimaxH3Model, ChannelID: channelID, Modes: []string{"t2v", "i2v", "r2v"},
		Limits: VideoLimits{LastFrame: true, References: map[string]int{"image": 2}, MaxReferences: 2},
	}}
	settings.data.Generation.DefaultModelID = modelID
	settings.data.Keys[channelID] = "fixture-key"
	return settings
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
			Nodes:     []NodeInput{{Type: "video", Content: promptMentionContent(t, "r2v", "参考素材", part)}},
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

func promptMentionContent(t *testing.T, mode, prompt string, parts ...map[string]any) json.RawMessage {
	t.Helper()
	content := map[string]any{"mode": mode, "prompt": prompt}
	if len(parts) > 0 {
		content["promptDoc"] = map[string]any{"type": "doc", "content": []any{map[string]any{"type": "paragraph", "content": parts}}}
	}
	return encodeMentionFixture(t, content)
}

func docText(text string) map[string]any {
	return map[string]any{"type": "text", "text": text}
}

func promptMentionPart(id, kind, label string) map[string]any {
	return map[string]any{"type": "assetMention", "attrs": assetMention{AssetID: id, AssetType: kind, Label: label}}
}
