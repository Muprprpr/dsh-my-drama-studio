package studio

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestCanvasVideoDraftCanSaveMediaBeforePrompt(t *testing.T) {
	dir := t.TempDir()
	s := New(providerFixture{})
	defer s.Close()
	bindSession(t, s, dir, "a")
	s.SetHumanWriteCheck(func(context.Context, string, string, []string) (bool, error) { return true, nil })
	image, note, video, appended := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	sources := []string{image}
	noPrompt := json.RawMessage(`{"mode":"i2v"}`)
	_, err := editCall(s, dir, "a", "human", "append", appendArgs{
		operation: operation{ID: "create-media-first"},
		Nodes: []NodeInput{
			{ID: image, Type: "image", Content: json.RawMessage(`{"path":"assets/images/first.png"}`)},
			{ID: note, Type: "note", Content: json.RawMessage(`{"text":"No text reference"}`)},
			{ID: video, Type: "video", Content: noPrompt},
			{ID: appended, Type: "video", Content: noPrompt},
		},
		Edges: []Edge{{Source: image, Target: appended}},
	})
	if err != nil {
		t.Fatal(err)
	}
	mustEdit(t, s, dir, "a", "update_node", updateNodeArgs{
		nodeRevisionArgs: nodeRevisionArgs{operation: operation{ID: "connect-before-prompt"}, ID: video, Revision: 1},
		Content:          noPrompt,
		ReferenceSources: &sources,
	})
	_, err = editCall(s, dir, "a", "human", "update_node", updateNodeArgs{
		nodeRevisionArgs: nodeRevisionArgs{operation: operation{ID: "reject-text"}, ID: video, Revision: 2},
		Content:          noPrompt,
		ReferenceSources: &[]string{note},
	})
	if err == nil || !strings.Contains(err.Error(), "不接受") {
		t.Fatalf("video draft accepted a text source: %v", err)
	}
	deleted, err := editCall(s, dir, "a", "human", "canvas_delete", canvasChangeArgs{
		operation: operation{ID: "delete-media-first-edge"},
		Edges:     []canvasEdgeVersion{{Edge: Edge{Source: image, Target: video}, Revision: 2}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := editCall(s, dir, "a", "human", "canvas_restore", canvasChangeArgs{
		operation: operation{ID: "restore-media-first-edge"},
		Edges:     deleted.(canvasChangeResult).Edges,
	}); err != nil {
		t.Fatal(err)
	}
	for i, id := range []string{video, appended} {
		result := mustCall(t, s, dir, "a", "query", queryArgs{ID: id}).(queryResult)
		var content map[string]json.RawMessage
		if err := json.Unmarshal(result.Nodes[0].Content, &content); err != nil {
			t.Fatal(err)
		}
		if !slices.Equal(result.Edges, []Edge{{Source: image, Target: id}}) || !slices.Equal(orderedSources(content), sources) {
			t.Fatalf("media-first draft lost its ordered connection: %+v", result)
		}
		request := map[string]any{"operationId": fmt.Sprintf("blank-submit-%d", i), "nodeId": id, "confirmed": true}
		if _, err := call(s, dir, "a", "generateI2V", request); err == nil || !strings.Contains(err.Error(), "完整提示词") {
			t.Fatalf("submission failed to require inline prompt: %v", err)
		}
	}
	tasks := mustCall(t, s, dir, "a", "tasks", nil).(map[string][]Task)["tasks"]
	if len(tasks) != 0 {
		t.Fatalf("blank drafts enqueued tasks: %+v", tasks)
	}
	mustEdit(t, s, dir, "a", "update_node", updateNodeArgs{
		nodeRevisionArgs: nodeRevisionArgs{operation: operation{ID: "write-prompt-after-connection"}, ID: video, Revision: 4},
		Content:          json.RawMessage(`{"mode":"i2v","prompt":"Keep @图片1 as the first frame."}`),
	})
	mustCall(t, s, dir, "a", "generateI2V", map[string]any{"operationId": "configured-submit", "nodeId": video, "confirmed": true})
}

func TestCanvasReferencesWaitResolveAndProtectTaskInput(t *testing.T) {
	dir := t.TempDir()
	s := New(providerFixture{})
	defer s.Close()
	bindSession(t, s, dir, "a")
	s.SetHumanWriteCheck(func(context.Context, string, string, []string) (bool, error) { return true, nil })
	image, video, independent := uuid.NewString(), uuid.NewString(), uuid.NewString()
	content := json.RawMessage(`{"mode":"i2v","prompt":"Continue the motion in @image1."}`)
	_, err := editCall(s, dir, "a", "human", "append", appendArgs{
		operation: operation{ID: "create"},
		Nodes: []NodeInput{
			{ID: image, Type: "image", Content: json.RawMessage(`{"prompt":"A frame."}`)},
			{ID: video, Type: "video", Content: content},
			{ID: independent, Type: "note", Content: json.RawMessage(`{}`)},
		},
		Edges: []Edge{{image, video}},
	})
	if err != nil {
		t.Fatal(err)
	}
	target := mustCall(t, s, dir, "a", "query", queryArgs{ID: video}).(queryResult)
	if len(target.ReferenceNodes) != 1 || target.ReferenceNodes[0].ID != image || len(target.ResolvedMedia) != 0 {
		t.Fatalf("missing pending reference: %+v", target)
	}
	request := map[string]any{"operationId": "video-submit", "nodeId": video, "confirmed": true}
	if _, err := call(s, dir, "a", "generateI2V", request); err == nil || !strings.Contains(err.Error(), "等待上游") {
		t.Fatalf("video submitted with pending image: %v", err)
	}
	const assetPath = "assets/images/frame.png"
	mustEdit(t, s, dir, "a", "update_node", updateNodeArgs{
		nodeRevisionArgs: nodeRevisionArgs{operation: operation{ID: "attach-image"}, ID: image, Revision: 1},
		Content:          json.RawMessage(fmt.Sprintf(`{"path":%q}`, assetPath)),
	})
	mustCall(t, s, dir, "a", "generateI2V", request)
	target = mustCall(t, s, dir, "a", "query", queryArgs{ID: video}).(queryResult)
	if !slices.Contains(target.LockedNodeIDs, video) || !slices.Contains(target.LockedNodeIDs, image) ||
		slices.Contains(target.LockedNodeIDs, independent) {
		t.Fatalf("wrong active task dependencies: %+v", target.LockedNodeIDs)
	}
	_, err = editCall(s, dir, "a", "human", "canvas_delete", canvasChangeArgs{
		operation: operation{ID: "delete-locked"},
		Nodes:     []canvasNodeVersion{{ID: image, Revision: 2}},
	})
	if err != workspaceBusy {
		t.Fatalf("active input could be removed: %v", err)
	}
	if _, err := editCall(s, dir, "a", "human", "append", appendArgs{
		operation: operation{ID: "link-into-locked-task-input"},
		Edges:     []Edge{{Source: independent, Target: image}},
	}); err != workspaceBusy {
		t.Fatalf("active task input accepted a new reference: %v", err)
	}
	if source := mustCall(t, s, dir, "a", "query", queryArgs{ID: image}).(queryResult); len(source.Edges) != 0 {
		t.Fatalf("rejected reference changed task input: %+v", source.Edges)
	}
	mustEdit(t, s, dir, "a", "update_node", updateNodeArgs{
		nodeRevisionArgs: nodeRevisionArgs{operation: operation{ID: "edit-independent"}, ID: independent, Revision: 1},
		Content:          json.RawMessage(`{"text":"This node is still editable."}`),
	})
	p, err := s.open(context.Background(), dir, false)
	if err != nil {
		t.Fatal(err)
	}
	var raw string
	err = p.db.QueryRow("SELECT input FROM tasks WHERE node_id=?", video).Scan(&raw)
	if err != nil {
		t.Fatal(err)
	}
	var snapshot generationRequest
	if err := json.Unmarshal([]byte(raw), &snapshot); err != nil {
		t.Fatal(err)
	}
	if snapshot.Prompt != "Continue the motion in @image1." ||
		!slices.Equal(snapshot.References, []GenerationReference{{Type: "image", Path: assetPath}}) {
		t.Fatalf("connected asset did not enter the generation snapshot: %+v", snapshot)
	}
}

func TestCanvasBatchDeleteRestoreKeepsAssetsAndOrderedEdges(t *testing.T) {
	dir := t.TempDir()
	s := New(providerFixture{})
	defer s.Close()
	bindSession(t, s, dir, "a")
	s.SetHumanWriteCheck(func(context.Context, string, string, []string) (bool, error) { return true, nil })
	first, last, video, duplicate := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	prompt := "Transition from @image1 to @image2."
	content := fmt.Sprintf(`{"mode":"i2v","prompt":%q,"mixedListOrder":[%q,%q]}`, prompt, first, last)
	mustCall(t, s, dir, "a", "append", appendArgs{
		operation: operation{ID: "create"},
		Nodes: []NodeInput{
			{ID: first, Type: "image", Content: json.RawMessage(`{"path":"assets/images/first.png"}`)},
			{ID: last, Type: "image", Content: json.RawMessage(`{"path":"assets/images/last.png"}`)},
			{ID: duplicate, Type: "image", Content: json.RawMessage(`{"path":"assets/images/last.png"}`)},
			{ID: video, Type: "video", Content: json.RawMessage(content)},
		},
		Edges: []Edge{{first, video}, {last, video}},
	})
	erase, err := editCall(s, dir, "a", "human", "canvas_delete", canvasChangeArgs{
		operation: operation{ID: "batch-delete"},
		Nodes:     []canvasNodeVersion{{ID: first, Revision: 1}, {ID: duplicate, Revision: 1}},
		Edges:     []canvasEdgeVersion{{Edge: Edge{Source: last, Target: video}, Revision: 1}},
	})
	if err != nil {
		t.Fatal(err)
	}
	deleted := erase.(canvasChangeResult)
	current := mustCall(t, s, dir, "a", "query", queryArgs{ID: video}).(queryResult)
	if len(current.Edges) != 0 || strings.Contains(string(current.Nodes[0].Content), "mixedListOrder") ||
		!strings.Contains(string(current.Nodes[0].Content), prompt) {
		t.Fatalf("deletion lost prompt or kept a live reference: %+v", current)
	}
	assets := mustCall(t, s, dir, "a", "query", queryArgs{Type: "image", MediaOnly: true}).(queryResult)
	if len(assets.Nodes) != 2 || !slices.ContainsFunc(assets.Nodes, func(n Node) bool { return n.ID == first && n.Deleted }) ||
		!slices.ContainsFunc(assets.Nodes, func(n Node) bool { return n.ID == last && !n.Deleted }) {
		t.Fatalf("asset picker lost original or displayed duplicates: %+v", assets)
	}
	request := map[string]any{"operationId": "stale", "nodeId": video, "confirmed": true}
	if _, err := call(s, dir, "a", "generateI2V", request); err == nil {
		t.Fatal("incomplete draft submitted after disconnect")
	}
	_, err = editCall(s, dir, "a", "human", "canvas_restore", canvasChangeArgs{
		operation: operation{ID: "undo-delete"}, Nodes: deleted.Nodes, Edges: deleted.Edges,
	})
	if err != nil {
		t.Fatal(err)
	}
	restored := exactNode(t, s, dir, "a", video)
	var restoredContent map[string]json.RawMessage
	if err := json.Unmarshal(restored.Content, &restoredContent); err != nil {
		t.Fatal(err)
	}
	if restored.Revision != 3 || !slices.Equal(orderedSources(restoredContent), []string{first, last}) {
		t.Fatalf("undo failed to restore original order: %+v", restored)
	}
	if archived := exactNode(t, s, dir, "a", first); archived.Deleted || archived.Revision != 3 {
		t.Fatalf("undo failed to restore the node: %+v", archived)
	}
}

func TestCanvasImageTextAndImageReferencesEnterSnapshot(t *testing.T) {
	dir := t.TempDir()
	s := New(providerFixture{})
	defer s.Close()
	bindSession(t, s, dir, "a")
	note, source, image := uuid.NewString(), uuid.NewString(), uuid.NewString()
	mustCall(t, s, dir, "a", "append", appendArgs{
		operation: operation{ID: "create"},
		Nodes: []NodeInput{
			{ID: note, Type: "prompt", Content: json.RawMessage(`{"prompt":"Natural window light."}`)},
			{ID: source, Type: "image", Content: json.RawMessage(`{"path":"assets/images/still.png"}`)},
			{ID: image, Type: "image", Content: json.RawMessage(`{"prompt":"A closeup of the actor."}`)},
		},
		Edges: []Edge{{note, image}, {source, image}},
	})
	mustCall(t, s, dir, "a", "submit_manual", map[string]any{"operationId": "image-submit", "nodeId": image, "confirmed": true})
	p, err := s.open(context.Background(), dir, false)
	if err != nil {
		t.Fatal(err)
	}
	var raw string
	if err := p.db.QueryRow("SELECT input FROM tasks WHERE node_id=?", image).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var snapshot generationRequest
	if err := json.Unmarshal([]byte(raw), &snapshot); err != nil {
		t.Fatal(err)
	}
	if snapshot.Prompt != "A closeup of the actor.\n\nNatural window light." ||
		!slices.Equal(snapshot.References, []GenerationReference{{Type: "image", Path: "assets/images/still.png"}}) {
		t.Fatalf("image references did not enter the generation snapshot: %+v", snapshot)
	}
}

func TestCanvasRepairKeepsInlineVideoPrompt(t *testing.T) {
	dir := t.TempDir()
	s := New(nil)
	bindSession(t, s, dir, "a")
	image, note, video := uuid.NewString(), uuid.NewString(), uuid.NewString()
	const prompt = "The user's current prompt. Continue from @image1."
	mustCall(t, s, dir, "a", "append", appendArgs{
		operation: operation{ID: "create"},
		Nodes: []NodeInput{
			{ID: image, Type: "image", Content: json.RawMessage(`{"path":"assets/images/frame.png"}`)},
			{ID: note, Type: "note", Content: json.RawMessage(`{"text":"Older wording."}`)},
			{ID: video, Type: "video", Content: json.RawMessage(fmt.Sprintf(`{"mode":"i2v","prompt":%q,"mixedListOrder":[%q]}`, prompt, image))},
		},
		Edges: []Edge{{image, video}},
	})
	p, err := s.open(context.Background(), dir, false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.db.Exec("INSERT INTO edges VALUES(?,?)", note, video); err != nil {
		t.Fatal(err)
	}
	if _, err := p.db.Exec("UPDATE nodes SET content=json_set(content,'$.textList',json_array(?),'$.mixedListOrder',json_array(?,?)) WHERE id=?",
		"Older wording.", note, image, video); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s = New(nil)
	defer s.Close()
	current := mustCall(t, s, dir, "a", "query", queryArgs{ID: video}).(queryResult)
	var content struct {
		Prompt         string
		TextList       []string
		MixedListOrder []string
	}
	if err := json.Unmarshal(current.Nodes[0].Content, &content); err != nil {
		t.Fatal(err)
	}
	if content.Prompt != prompt || len(content.TextList) != 0 ||
		!slices.Equal(content.MixedListOrder, []string{image}) || !slices.Equal(current.Edges, []Edge{{image, video}}) {
		t.Fatalf("video repair changed prompt or kept text references: %+v / %+v", content, current.Edges)
	}
}
