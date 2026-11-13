package studio

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestVideoAssetPlaceholderLifecycle(t *testing.T) {
	dir := t.TempDir()
	s := New(nil)
	defer s.Close()
	bindSession(t, s, dir, "a")
	s.SetHumanWriteCheck(func(context.Context, string, string, []string, []string) (bool, error) { return true, nil })
	asset, image := uuid.NewString(), uuid.NewString()
	_, err := editCall(s, dir, "a", "human", "append", appendArgs{
		operation: operation{ID: "create-assets"},
		Nodes: []NodeInput{
			{ID: asset, Type: "video", Content: json.RawMessage(`{"mode":"asset","title":"视频素材"}`)},
			{ID: image, Type: "image", Content: json.RawMessage(`{"path":"assets/images/frame.png"}`)},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if node := exactNode(t, s, dir, "a", asset); node.Revision != 1 || !strings.Contains(string(node.Content), `"mode":"asset"`) {
		t.Fatalf("video placeholder was not saved: %+v", node)
	}
	mustEdit(t, s, dir, "a", "update_node", updateNodeArgs{
		nodeRevisionArgs: nodeRevisionArgs{operation: operation{ID: "attach-clip"}, ID: asset, Revision: 1},
		Content:          json.RawMessage(`{"mode":"asset","path":"assets/videos/clip.mp4","title":"已有视频"}`),
	})
	for _, test := range []struct {
		name, content, want string
		sources             *[]string
	}{
		{name: "incoming media", content: `{"mode":"asset"}`, sources: &[]string{image}, want: "不能接入生成参考"},
		{name: "inline prompt", content: `{"mode":"asset","prompt":"A scene"}`, want: "不能保存生成提示词"},
		{name: "model profile", content: `{"mode":"asset","profileId":"profile"}`, want: "不能保存生成提示词"},
		{name: "generation parameters", content: `{"mode":"asset","params":{"duration":5}}`, want: "不能保存生成提示词"},
		{name: "legacy text list", content: `{"mode":"asset","textList":["script"]}`, want: "textList 必须为空"},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, err := editCall(s, dir, "a", "human", "update_node", updateNodeArgs{
				nodeRevisionArgs: nodeRevisionArgs{operation: operation{ID: test.name}, ID: asset, Revision: 2},
				Content:          json.RawMessage(test.content),
				ReferenceSources: test.sources,
			})
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("update returned %v, want %q", err, test.want)
			}
		})
	}
	result := mustCall(t, s, dir, "a", "query", queryArgs{ID: asset}).(queryResult)
	if len(result.Edges) != 0 || len(result.Nodes) != 1 || result.Nodes[0].Revision != 2 ||
		!strings.Contains(string(result.Nodes[0].Content), `"path":"assets/videos/clip.mp4"`) {
		t.Fatalf("invalid updates altered the asset or graph: %+v", result)
	}
	for _, action := range []string{"submit_manual", "generateT2V"} {
		_, err := call(s, dir, "a", action, map[string]any{"operationId": action, "nodeId": asset, "confirmed": true})
		if err == nil || !strings.Contains(err.Error(), "请选择视频生成草稿") {
			t.Fatalf("%s allowed asset submission: %v", action, err)
		}
	}
}

func TestVideoNodeMediaModes(t *testing.T) {
	dir := t.TempDir()
	s := New(nil)
	defer s.Close()
	bindSession(t, s, dir, "a")
	first, last, video, audio := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	assets := []NodeInput{
		{ID: first, Type: "image", Content: json.RawMessage(`{"path":"assets/images/first.png"}`)},
		{ID: last, Type: "image", Content: json.RawMessage(`{"path":"assets/images/last.png"}`)},
		{ID: video, Type: "video", Content: json.RawMessage(`{"path":"assets/custom-output/clip.mp4","providerTaskId":"fixture","protocol":"source asset metadata"}`)},
		{ID: audio, Type: "audio", Content: json.RawMessage(`{"path":"assets/audio/sound.wav"}`)},
	}
	mustCall(t, s, dir, "a", "append", appendArgs{operation: operation{ID: "assets"}, Nodes: assets})
	for _, fixture := range []struct {
		name, mode, prompt, errorText string
		sources                       []string
	}{
		{name: "T2V", mode: "t2v", prompt: "镜头推进，保留完整内联提示词。"},
		{name: "I2V with end frame", mode: "i2v", prompt: "从 @图片1 到 @图片2。", sources: []string{first, last}},
		{name: "R2V mixed media", mode: "r2v", prompt: "保留 @视频1 的节奏，采用 @图片1 的颜色和 @音频1。", sources: []string{video, audio, first}},
		{name: "V2V", mode: "v2v", prompt: "编辑 @视频1。", sources: []string{video}},
		{name: "legacy no mode", prompt: "参照 @音频1。", sources: []string{audio}},
		{name: "T2V rejects media", mode: "t2v", prompt: "文字。", sources: []string{first}, errorText: "T2V 只接受"},
		{name: "I2V needs images", mode: "i2v", prompt: "文字。", sources: []string{first, video}, errorText: "I2V 需要首帧图片"},
		{name: "R2V needs media", mode: "r2v", prompt: "文字。", errorText: "R2V 需要至少一个"},
		{name: "V2V needs one video", mode: "v2v", prompt: "文字。", sources: []string{video, audio}, errorText: "V2V 需要一个源视频"},
		{name: "V2V rejects image", mode: "v2v", prompt: "文字。", sources: []string{first}, errorText: "V2V 需要一个源视频"},
		{name: "text reference rejected", mode: "r2v", prompt: "见 @提示词1。", sources: []string{first}, errorText: "没有对应"},
		{name: "missing audio reference", mode: "r2v", prompt: "参照 @音频2。", sources: []string{audio}, errorText: "没有对应"},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			id := uuid.NewString()
			content, err := json.Marshal(map[string]any{
				"mode": fixture.mode, "prompt": fixture.prompt, "mixedListOrder": fixture.sources, "textList": []string{},
			})
			if err != nil {
				t.Fatal(err)
			}
			edges := make([]Edge, 0, len(fixture.sources))
			for _, source := range fixture.sources {
				edges = append(edges, Edge{Source: source, Target: id})
			}
			_, err = call(s, dir, "a", "append", appendArgs{operation: operation{ID: fixture.name},
				Nodes: []NodeInput{{ID: id, Type: "video", Content: content}}, Edges: edges})
			if fixture.errorText != "" {
				if err == nil || !strings.Contains(err.Error(), fixture.errorText) {
					t.Fatalf("append = %v, want %q", err, fixture.errorText)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			stored := mustCall(t, s, dir, "a", "query", queryArgs{ID: id}).(queryResult)
			if len(stored.Nodes) != 1 || string(stored.Nodes[0].Content) != string(content) {
				t.Fatalf("stored draft differs from user content: %+v", stored.Nodes)
			}
		})
	}
}

func TestVideoNodeRejectsChannelFieldsAndEscapingPaths(t *testing.T) {
	dir := t.TempDir()
	s := New(nil)
	defer s.Close()
	bindSession(t, s, dir, "a")
	for _, field := range []string{"apiKey", "base_url", "protocol", "requestMapping"} {
		content := fmt.Sprintf(`{"mode":"t2v","prompt":"镜头推进。",%q:"fixture"}`, field)
		_, err := call(s, dir, "a", "append", appendArgs{operation: operation{ID: field},
			Nodes: []NodeInput{{Type: "video", Content: json.RawMessage(content)}}})
		if err == nil || !strings.Contains(err.Error(), "全局设置") || strings.Contains(err.Error(), "fixture") {
			t.Fatalf("channel field %q: %v", field, err)
		}
	}
	_, err := call(s, dir, "a", "append", appendArgs{operation: operation{ID: "nested secret"},
		Nodes: []NodeInput{{Type: "video", Content: json.RawMessage(`{"prompt":"镜头推进。","params":{"apiKey":"fixture"}}`)}}})
	if err == nil || !strings.Contains(err.Error(), "参数仅支持") || strings.Contains(err.Error(), "fixture") {
		t.Fatalf("nested channel credential: %v", err)
	}
	for _, fixture := range []struct{ kind, path string }{
		{"audio", "assets/audios/sound.wav"},
		{"audio", "assets/audio/../sound.wav"},
		{"video", "assets/../secrets.mp4"},
		{"video", "assets/custom/clip.mp4:stream"},
	} {
		content := json.RawMessage(fmt.Sprintf(`{"path":%q}`, fixture.path))
		if err := validateNode(NodeInput{Type: fixture.kind, Content: content}); err == nil {
			t.Fatalf("invalid %s path was accepted: %s", fixture.kind, fixture.path)
		}
	}
}
