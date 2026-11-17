package studio

import (
	"context"
	"net/http"
	"reflect"
	"testing"
)

func TestProductionSettingsBeforeCanvasAndAcrossSessions(t *testing.T) {
	f := newWorkflowTest(t, nil)
	const get, save = "production_settings_get", "production_settings_save"
	initial := f.call("first", "human", get, nil).(productionSettings)
	if initial.Spec.AspectRatio != "" || initial.Spec.TargetDurationSeconds != nil || initial.AutoGenerate {
		t.Fatalf("unexpected defaults: %+v", initial)
	}
	enabled := true
	seconds := int64(24)
	spec := productionSpec{AspectRatio: "9:16", TargetDurationSeconds: &seconds}
	args := productionSettingsArgs{operation: workflowOp(), Spec: &spec, AutoGenerate: &enabled}
	f.check("first", "", save, args, http.StatusForbidden)
	saved := f.call("first", "human", save, args).(productionSettings)
	if !saved.AutoGenerate || !reflect.DeepEqual(saved.Spec, spec) {
		t.Fatalf("settings lost before binding: %+v", saved)
	}
	if status := mustCall(t, f.s, f.dir, "first", "context", nil).(Status); status.Connected || !status.AutoGenerate {
		t.Fatalf("saving should not bind Canvas and must set Session permission: %+v", status)
	}
	if view := f.view("first"); !view.ProfileSelectionRequired || view.Session.ActiveStageID != "" {
		t.Fatalf("saving created an active Workflow: %+v", view)
	}
	p, err := f.s.open(context.Background(), f.dir, false)
	if err != nil {
		t.Fatal(err)
	}
	var count int
	if err := p.db.QueryRow("SELECT COUNT(*) FROM tasks").Scan(&count); err != nil || count != 0 {
		t.Fatalf("enabling queued generation: count=%d err=%v", count, err)
	}
	checkShared := func(session string) {
		t.Helper()
		got := f.call(session, "human", get, nil).(productionSettings)
		if got.AutoGenerate || !reflect.DeepEqual(got.Spec, spec) {
			t.Fatalf("expected project spec without inherited Session permission: %+v", got)
		}
	}
	checkShared("peer")
	other, err := editCall(f.s, t.TempDir(), "first", "human", get, nil)
	if err != nil || !reflect.DeepEqual(other, initial) {
		t.Fatalf("settings crossed Workspace: %+v %v", other, err)
	}
	f.reopen(nil)
	checkShared("first")
	checkShared("peer")
}

func TestProductionSpecKeepsRunBasisAndRevalidatesHandoffs(t *testing.T) {
	f := newWorkflowTest(t, nil)
	const topic = "topic-selection"
	setSpec := func(ratio string, duration *int64) {
		t.Helper()
		f.call("settings", "human", "production_settings_save", productionSettingsArgs{
			operation: workflowOp(), Spec: &productionSpec{AspectRatio: ratio, TargetDurationSeconds: duration},
		})
	}
	f.call("writer", "human", "workflow_profile_select", workflowProfileArgs{
		operation: workflowOp(), WorkflowProfileID: "short-video",
	})
	setSpec("16:9", nil)
	f.activate("writer", topic)
	f.activate("peer", topic)
	turn := f.start("writer", topic, "")
	if len(turn.Inputs) != 0 || turn.ProductionSpec.AspectRatio != "16:9" || turn.ProductionSpec.TargetDurationSeconds != nil {
		t.Fatalf("first-stage admission lost its default specification: %+v", turn)
	}
	draft := f.draft("writer", turn.Session.RunID, "old aspect and unset runtime", workflowArtifact{})
	f.finish("writer", turn.Session.RunID, "")
	preview := f.preview("writer", draft.workflowArtifactRef)
	setSpec("16:9", nil)
	enabled := true
	f.call("writer", "human", "production_settings_save", productionSettingsArgs{
		operation: workflowOp(), AutoGenerate: &enabled,
	})
	handoff := f.confirm("writer", preview)
	if handoff.Stale || draft.inputKey != preview.PreviewBaseline.InputKey {
		t.Fatalf("same effective aspect and toggle invalidated handoff: %+v", handoff)
	}

	peer := f.start("peer", topic, "")
	prior := f.draft("peer", peer.Session.RunID, "old aspect plan", workflowArtifact{})
	seconds := int64(30)
	setSpec("9:16", &seconds)
	// The active turn can still read and update a draft that uses its own input key.
	read := f.call("peer", "workflow", "workflow_artifact_get", map[string]any{
		"artifactId": prior.ArtifactID, "scope": "draft", "runId": peer.Session.RunID,
	}).(workflowArtifact)
	updated := f.draft("peer", peer.Session.RunID, "old aspect plan revised while running", prior)
	if read.inputKey != prior.inputKey || updated.inputKey != prior.inputKey || updated.ReusedFrom != nil {
		t.Fatalf("running turn switched to current settings: read=%+v updated=%+v", read, updated)
	}
	f.finish("peer", peer.Session.RunID, "")
	view := f.view("peer")
	if len(view.Handoffs) != 1 || !view.Handoffs[0].Stale || !view.Artifacts[0].InputOutdated {
		t.Fatalf("old official and draft results must show they need review: %+v", view)
	}
	f.check("peer", "human", "workflow_handoff_preview", workflowPreviewArgs{
		operation: workflowOp(), Artifacts: []workflowArtifactRef{updated.workflowArtifactRef},
	}, http.StatusConflict)

	next := f.start("peer", topic, "")
	if len(next.Artifacts) != 0 || next.ProductionSpec.AspectRatio != "9:16" ||
		next.ProductionSpec.TargetDurationSeconds == nil || *next.ProductionSpec.TargetDurationSeconds != seconds {
		t.Fatalf("next admission should see only current settings: %+v", next)
	}
	reviewed := f.draft("peer", next.Session.RunID, "plan reviewed for vertical", updated)
	f.finish("peer", next.Session.RunID, "")
	reviewPreview := f.preview("peer", reviewed.workflowArtifactRef)
	if len(reviewPreview.ReuseReviews) != 1 ||
		reviewPreview.ReuseReviews[0].PreviousProductionSpec.AspectRatio != "16:9" ||
		!reflect.DeepEqual(reviewPreview.ReuseReviews[0].CurrentProductionSpec, &next.ProductionSpec) {
		t.Fatalf("handoff review lost production basis: %+v", reviewPreview.ReuseReviews)
	}
	newDuration := int64(40)
	setSpec("9:16", &newDuration)
	f.check("peer", "human", "workflow_handoff_confirm", workflowConfirmArgs{
		operation: workflowOp(), HandoffID: reviewPreview.HandoffID,
	}, http.StatusConflict)
}
