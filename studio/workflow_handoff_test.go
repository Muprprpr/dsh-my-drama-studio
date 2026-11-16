package studio

import (
	"context"
	"encoding/json"
	"testing"
)

func TestWorkflowHandoffPreviewScope(t *testing.T) {
	const topic = "topic-selection"
	const analysis = "content-analysis"
	f := newWorkflowTest(t, nil)
	f.call("a", "human", "workflow_profile_select", workflowProfileArgs{operation: workflowOp(), WorkflowProfileID: "short-video"})
	f.activate("a", topic)
	save := func(session, stage, title, content string, prior workflowArtifact) workflowArtifact {
		t.Helper()
		turn := f.start(session, stage, "")
		artifact := f.call(session, "workflow", "workflow_save_artifact", workflowSaveArtifactArgs{
			operation: workflowOp(), RunID: turn.Session.RunID, ArtifactID: prior.ArtifactID,
			ExpectedVersion: prior.Version, Title: title, Content: content,
		}).(workflowArtifact)
		f.finish(session, turn.Session.RunID, "")
		return artifact
	}
	proposal := save("a", topic, "选题方案", "原始选题", workflowArtifact{})
	document := save("a", topic, "选题交接文档", "引用选题方案 V1，受众是初次观看的观众。", workflowArtifact{})
	preview := f.preview("a", proposal.workflowArtifactRef, document.workflowArtifactRef)
	assertConflict := func(session string, h workflowHandoff, expected error) {
		t.Helper()
		_, err := editCall(f.s, f.dir, session, "human", "workflow_handoff_confirm", workflowConfirmArgs{
			operation: workflowOp(), HandoffID: h.HandoffID,
		})
		if err != expected {
			t.Fatalf("confirmation returned %v, want %v", err, expected)
		}
	}
	updated := save("a", topic, proposal.Title, "更新后的选题", proposal)
	assertConflict("a", preview, workflowHandoffContentChanged)
	if view := f.view("a"); len(view.Artifacts) != 3 || len(view.Handoffs) != 0 || view.Session.ActiveStageID != topic {
		t.Fatalf("a stale preview modified durable state: %+v", view)
	}

	// Deliberately include V1 even though V2 exists at preview time.
	preview = f.preview("a", proposal.workflowArtifactRef, document.workflowArtifactRef)
	if preview.PreviewBaseline.ArtifactHeads[proposal.ArtifactID] != updated.Version ||
		preview.WorkflowProfileID != "short-video" || preview.WorkflowDefinitionVersion != 1 || preview.SourceRevision != 0 {
		t.Fatalf("preview did not record its actual baseline: %+v", preview)
	}
	save("a", topic, "未选中的草稿", "与交接无关", workflowArtifact{})
	for _, session := range []string{"a", "b"} {
		bindSession(t, f.s, f.dir, session)
	}
	f.s.SetHumanWriteCheck(func(context.Context, string, string, []string) (bool, error) { return true, nil })
	node := mustCall(t, f.s, f.dir, "b", "append", appendArgs{
		operation: workflowOp(), Nodes: []NodeInput{{Type: "note", Content: json.RawMessage(`{"text":"unrelated"}`)}},
	}).(appendResult).IDs[0]
	mustEdit(t, f.s, f.dir, "b", "update_node", updateNodeArgs{
		nodeRevisionArgs: nodeRevisionArgs{operation: workflowOp(), ID: node, Revision: 1},
		Content:          json.RawMessage(`{"text":"unrelated, updated"}`),
	})
	first := f.confirm("a", preview)
	if first.SourceRevision != 1 || first.Artifacts[0].Version != proposal.Version || first.TargetStageID != analysis {
		t.Fatalf("unexpected formal revision or selected artifacts: %+v", first)
	}
	f.activate("b", analysis)
	peerDraft := save("b", analysis, "分析稿", "依据选题交接包", workflowArtifact{})
	peerPreview := f.preview("b", peerDraft.workflowArtifactRef)
	if peerPreview.PreviewBaseline.InputKey != workflowInputKey([]workflowHandoff{first}) {
		t.Fatalf("preview lost the upstream formal handoff reference: %+v", peerPreview)
	}
	if item := f.call("b", "workflow", "workflow_artifact_get", document.workflowArtifactRef).(workflowArtifact); item.Content != document.Content {
		t.Fatalf("next stage read the wrong handoff document: %+v", item)
	}
	f.activate("a", topic)
	updatedPreview := f.preview("a", updated.workflowArtifactRef, document.workflowArtifactRef)
	f.confirm("b", peerPreview) // A downstream formal revision is unrelated to the topic preview's inputs.
	f.activate("b", analysis)
	peerDraft = save("b", analysis, peerDraft.Title, "另一个分析版本", peerDraft)
	peerPreview = f.preview("b", peerDraft.workflowArtifactRef)
	second := f.confirm("a", updatedPreview)
	if second.SourceRevision != 3 || second.Artifacts[0].Version != updated.Version {
		t.Fatalf("new formal sequence did not preserve the scoped selection: %+v", second)
	}
	assertConflict("b", peerPreview, workflowHandoffContentChanged)
}

func TestWorkflowHandoffRejectsEditedSharedCanvasArtifact(t *testing.T) {
	f := newWorkflowTest(t, nil)
	const topic = "topic-selection"
	f.call("a", "human", "workflow_profile_select", workflowProfileArgs{operation: workflowOp(), WorkflowProfileID: "short-video"})
	for _, session := range []string{"a", "b"} {
		bindSession(t, f.s, f.dir, session)
	}
	f.s.SetHumanWriteCheck(func(context.Context, string, string, []string) (bool, error) { return true, nil })
	node := mustCall(t, f.s, f.dir, "a", "append", appendArgs{
		operation: workflowOp(), Nodes: []NodeInput{{Type: "note", Content: json.RawMessage(`{"text":"topic references"}`)}},
	}).(appendResult).IDs[0]
	f.activate("a", topic)
	turn := f.start("a", topic, "")
	artifact := f.call("a", "workflow", "workflow_save_artifact", workflowSaveArtifactArgs{
		operation: workflowOp(), RunID: turn.Session.RunID, Title: "引用中的选题素材", NodeID: node,
	}).(workflowArtifact)
	f.finish("a", turn.Session.RunID, "")
	preview := f.preview("a", artifact.workflowArtifactRef)
	mustEdit(t, f.s, f.dir, "b", "update_node", updateNodeArgs{
		nodeRevisionArgs: nodeRevisionArgs{operation: workflowOp(), ID: node, Revision: 1},
		Content:          json.RawMessage(`{"text":"changed by peer Session"}`),
	})
	_, err := editCall(f.s, f.dir, "a", "human", "workflow_handoff_confirm", workflowConfirmArgs{
		operation: workflowOp(), HandoffID: preview.HandoffID,
	})
	if err != workflowHandoffContentChanged || len(f.view("a").Handoffs) != 0 {
		t.Fatalf("another Session changed a selected Canvas reference: %v", err)
	}
}

func TestWorkflowHandoffChecksDefinitionActivationAndPermission(t *testing.T) {
	f := newWorkflowTest(t, nil)
	const stage = "shooting-script"
	f.call("a", "human", "workflow_profile_select", workflowProfileArgs{operation: workflowOp(), WorkflowProfileID: "short-drama"})
	f.activate("a", stage)
	turn := f.start("a", stage, "")
	f.draft("a", turn.Session.RunID, "待交接的拍摄脚本", workflowArtifact{})
	f.finish("a", turn.Session.RunID, "")
	preview := f.preview("a")
	check := func(session string, expected error) {
		t.Helper()
		_, err := editCall(f.s, f.dir, session, "human", "workflow_handoff_confirm", workflowConfirmArgs{
			operation: workflowOp(), HandoffID: preview.HandoffID,
		})
		if err != expected {
			t.Fatalf("confirmation returned %v, want %v", err, expected)
		}
	}
	check("b", workflowHandoffPermission)
	p, err := f.s.open(context.Background(), f.dir, false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.db.Exec(`UPDATE workflow_profile SET definition_version=2`); err != nil {
		t.Fatal(err)
	}
	check("a", workflowHandoffDefinitionChanged)
	if _, err := p.db.Exec(`UPDATE workflow_profile SET definition_version=1`); err != nil {
		t.Fatal(err)
	}
	f.activate("a", "")
	check("a", workflowHandoffActivationChanged)
}

func TestWorkflowHandoffConcurrentReplayDoesNotDispatchTwice(t *testing.T) {
	f := newWorkflowTest(t, nil)
	const stage = "storyboard"
	f.activate("a", stage)
	turn := f.start("a", stage, "")
	f.draft("a", turn.Session.RunID, "选定分镜", workflowArtifact{})
	f.finish("a", turn.Session.RunID, "")
	preview := f.preview("a")
	other := New(nil)
	defer other.Close()
	ready := make(chan struct{})
	type outcome struct {
		result any
		err    error
	}
	results := make(chan outcome, 2)
	for _, kernel := range []*Service{f.s, other} {
		go func(kernel *Service) {
			<-ready
			result, err := editCall(kernel, f.dir, "a", "human", "workflow_handoff_confirm", workflowConfirmArgs{
				operation: workflowOp(), HandoffID: preview.HandoffID, Snapshot: workflowTestSnapshot(preview.TargetStageID, "V1"),
			})
			results <- outcome{result, err}
		}(kernel)
	}
	close(ready)
	commits := 0
	for range 2 {
		result := <-results
		if result.err != nil {
			t.Fatal(result.err)
		}
		confirmation := result.result.(workflowHandoffConfirmation)
		if confirmation.Handoff.HandoffID != preview.HandoffID || confirmation.Handoff.SourceRevision != 1 {
			t.Fatalf("unexpected receipt for repeated confirmation: %+v", confirmation)
		}
		if confirmation.Committed {
			commits++
		}
	}
	view := f.view("a")
	if commits != 1 || len(view.Handoffs) != 1 || view.Session.PendingHandoffID != preview.HandoffID || view.Session.Activation != 2 {
		t.Fatalf("duplicate formal commit or dispatch permission: commits=%d view=%+v", commits, view)
	}
}
