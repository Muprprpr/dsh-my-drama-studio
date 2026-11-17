package studio

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/google/uuid"
)

func TestVideoDraftPinsAdmittedAspectAndKeepsExplicitOverride(t *testing.T) {
	f := newWorkflowTest(t, providerFixture{})
	bindSession(t, f.s, f.dir, "a")
	const stage = "content-analysis"
	f.activate("a", stage)
	f.call("a", "human", "production_settings_save", productionSettingsArgs{operation: workflowOp(),
		Spec: &productionSpec{AspectRatio: "16:9"}})
	first := f.start("a", stage, "")
	f.call("b", "human", "production_settings_save", productionSettingsArgs{operation: workflowOp(),
		Spec: &productionSpec{AspectRatio: "9:16"}})

	oldDraft, newDraft, asset := uuid.NewString(), uuid.NewString(), uuid.NewString()
	appendVideo := func(runID, id, raw string) appendArgs {
		return appendArgs{operation: workflowOp(), RunID: runID,
			Nodes: []NodeInput{{ID: id, Type: "video", Content: json.RawMessage(raw)}}}
	}
	f.call("a", "workflow", "append", appendVideo(first.Session.RunID, oldDraft,
		`{"mode":"t2v","prompt":"Wait and look left.","params":{"aspectRatio":"1:1"}}`))
	f.finish("a", first.Session.RunID, "")
	second := f.start("a", stage, "")
	const prompt = `{"mode":"t2v","prompt":"Wait and look left."}`
	f.check("a", "workflow", "append", appendVideo(first.Session.RunID, newDraft, prompt), http.StatusForbidden)
	f.call("a", "workflow", "append", appendVideo(second.Session.RunID, newDraft, prompt))
	f.call("a", "workflow", "append", appendVideo(second.Session.RunID, asset, `{"mode":"asset","path":"assets/videos/retained.mp4"}`))
	f.finish("a", second.Session.RunID, "")

	check := func(id, ratio, explicit string) {
		t.Helper()
		result := f.call("a", "", "query", queryArgs{ID: id}).(queryResult)
		if len(result.Nodes) != 1 {
			t.Fatalf("missing Canvas node %s", id)
		}
		var content struct {
			ProductionAspectRatio string
			Params                VideoParams
		}
		if err := json.Unmarshal(result.Nodes[0].Content, &content); err != nil ||
			content.ProductionAspectRatio != ratio || content.Params.AspectRatio != explicit {
			t.Fatalf("unexpected production default or override: %s, %v", result.Nodes[0].Content, err)
		}
	}
	check(oldDraft, "16:9", "1:1")
	check(newDraft, "9:16", "")
	check(asset, "", "")
	f.s.SetHumanWriteCheck(func(context.Context, string, string, []string) (bool, error) { return true, nil })
	f.call("a", "human", "update_node", updateNodeArgs{
		nodeRevisionArgs: nodeRevisionArgs{operation: workflowOp(), ID: oldDraft, Revision: 1},
		Content:          json.RawMessage(`{"mode":"t2v","prompt":"Keep the actor still.","params":{"aspectRatio":"1:1"}}`),
	})
	check(oldDraft, "16:9", "1:1")
}

func TestAutomaticGenerationUsesCurrentSessionPermissionAndDeployment(t *testing.T) {
	f := newWorkflowTest(t, providerFixture{})
	on, off := true, false
	f.call("peer", "human", "production_settings_save", productionSettingsArgs{operation: workflowOp(), AutoGenerate: &on})
	if !bindSession(t, f.s, f.dir, "peer").AutoGenerate || bindSession(t, f.s, f.dir, "editor").AutoGenerate {
		t.Fatal("prebinding automation grant did not remain scoped to its Session")
	}
	if tasks := tasksIn(t, f.s, f.dir, "peer"); len(tasks) != 0 {
		t.Fatalf("enabling automatic generation queued work: %+v", tasks)
	}
	f.seedLegacyBefore(workflowDeployment)
	f.activate("editor", workflowDeployment)
	editor := f.start("editor", workflowDeployment, "")
	create := f.call("editor", "workflow", "append", appendArgs{operation: workflowOp(), RunID: editor.Session.RunID, Nodes: []NodeInput{
		{Type: "video", Content: json.RawMessage(`{"mode":"t2v","prompt":"Close on the window."}`)},
	}}).(appendResult)
	id := create.IDs[0]
	submit := func() submitArgs { return submitArgs{operation: workflowOp(), NodeID: id} }
	f.check("peer", "agent", "submit", submit(), http.StatusForbidden)
	artifact := f.call("editor", "workflow", "workflow_save_artifact", workflowSaveArtifactArgs{
		operation: workflowOp(), RunID: editor.Session.RunID, Title: "窗口", NodeID: id,
	}).(workflowArtifact)
	f.finish("editor", editor.Session.RunID, "")
	f.check("peer", "agent", "submit", submit(), http.StatusForbidden)
	f.confirm("editor", f.preview("editor", artifact.workflowArtifactRef))
	if tasks := tasksIn(t, f.s, f.dir, "peer"); len(tasks) != 0 {
		t.Fatalf("deployment confirmation queued work without a submit request: %+v", tasks)
	}
	f.check("editor", "agent", "submit", submit(), http.StatusForbidden)
	f.call("peer", "agent", "submit", submit())
	project, err := f.s.open(context.Background(), f.dir, false)
	if err != nil {
		t.Fatal(err)
	}
	tasks := tasksIn(t, f.s, f.dir, "peer")
	taskID := tasks[0].ID
	var before, after string
	if err := project.db.QueryRow("SELECT input FROM tasks WHERE id=?", taskID).Scan(&before); err != nil {
		t.Fatal(err)
	}
	f.call("peer", "human", "production_settings_save", productionSettingsArgs{operation: workflowOp(), AutoGenerate: &off})
	f.check("peer", "agent", "submit", submit(), http.StatusForbidden)

	f.call("editor", "human", "submit_manual", map[string]any{
		"operationId": uuid.NewString(), "nodeId": id, "confirmed": true,
	})
	f.call("peer", "human", "production_settings_save", productionSettingsArgs{operation: workflowOp(),
		AutoGenerate: &on, Spec: &productionSpec{AspectRatio: "9:16"}})
	f.check("peer", "agent", "submit", submit(), http.StatusForbidden)
	if err := project.db.QueryRow("SELECT input FROM tasks WHERE id=?", taskID).Scan(&after); err != nil || after != before {
		t.Fatalf("a setting change rewrote the admitted task: %s; %s; %v", before, after, err)
	}
	if tasks := tasksIn(t, f.s, f.dir, "peer"); len(tasks) != 2 {
		t.Fatalf("expected only one permitted automatic task and one manually authorized task: %+v", tasks)
	}
}
