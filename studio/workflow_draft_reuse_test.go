package studio

import (
	"net/http"
	"slices"
	"testing"
)

func TestWorkflowDraftReuseKeepsInputProvenanceThroughConfirmation(t *testing.T) {
	f := newWorkflowTest(t, nil)
	const topic, analysis = "topic-selection", "content-analysis"
	f.call("writer", "human", "workflow_profile_select", workflowProfileArgs{
		operation: workflowOp(), WorkflowProfileID: "short-video",
	})
	save := func(session, run, body string, prior workflowArtifactRef, notes workflowArtifactNotes) workflowArtifact {
		t.Helper()
		return f.call(session, "workflow", "workflow_save_artifact", workflowSaveArtifactArgs{
			operation: workflowOp(), RunID: run, Title: "选题与分析", Content: body,
			ArtifactID: prior.ArtifactID, ExpectedVersion: prior.Version, workflowArtifactNotes: notes,
		}).(workflowArtifact)
	}
	publishTopic := func(session, body, duration string) workflowHandoff {
		t.Helper()
		f.activate(session, topic)
		turn := f.start(session, topic, "")
		item := save(session, turn.Session.RunID, body, workflowArtifactRef{}, workflowArtifactNotes{
			Constraints: []string{duration, "保留普通话对白"},
		})
		f.finish(session, turn.Session.RunID, "")
		return f.confirm(session, f.preview(session, item.workflowArtifactRef))
	}

	original := publishTopic("writer", "旧选题", "90 秒")
	turn := f.start("writer", analysis, original.HandoffID)
	localNotes := workflowArtifactNotes{ConfirmedDecisions: []string{"保留旧选题夜景"}, Constraints: []string{"只拍夜景"}}
	draft := save("writer", turn.Session.RunID, "同一份分析正文", workflowArtifactRef{}, localNotes)
	f.finish("writer", turn.Session.RunID, "")
	turn = f.start("writer", analysis, "")
	if len(turn.Artifacts) != 1 || turn.Artifacts[0].workflowArtifactRef != draft.workflowArtifactRef {
		t.Fatalf("same input did not restore its working draft: %+v", turn.Artifacts)
	}

	updated := publishTopic("peer", "新版选题", "45 秒")
	stable := save("writer", turn.Session.RunID, draft.Content, draft.workflowArtifactRef, workflowArtifactNotes{})
	if stable.inputKey != draft.inputKey || !slices.Equal(stable.ConfirmedDecisions, localNotes.ConfirmedDecisions) ||
		!slices.Equal(stable.Constraints, localNotes.Constraints) || stable.ReusedFrom != nil {
		t.Fatalf("running turn changed its basis or failed same-input inheritance: %+v", stable)
	}
	f.finish("writer", turn.Session.RunID, "")
	f.check("writer", "human", "workflow_handoff_preview", workflowPreviewArgs{
		operation: workflowOp(), Artifacts: []workflowArtifactRef{stable.workflowArtifactRef},
	}, http.StatusConflict)

	turn = f.start("writer", analysis, "")
	if len(turn.Inputs) != 1 || turn.Inputs[0].HandoffID != updated.HandoffID || len(turn.Artifacts) != 0 {
		t.Fatalf("new turn received the wrong input or an old working draft: %+v", turn)
	}
	historic := f.call("writer", "human", "workflow_artifact_get", stable.workflowArtifactRef).(workflowArtifact)
	if historic.Content != stable.Content || historic.Version != stable.Version {
		t.Fatalf("human could not inspect historical draft: %+v", historic)
	}
	reused := save("writer", turn.Session.RunID, historic.Content, historic.workflowArtifactRef, workflowArtifactNotes{})
	if reused.ReusedFrom == nil || *reused.ReusedFrom != stable.workflowArtifactRef ||
		reused.inputKey != workflowInputKey(turn.Inputs, turn.ProductionSpec) || len(reused.Constraints) != 0 || len(reused.ConfirmedDecisions) != 0 {
		t.Fatalf("cross-input save lost provenance or inherited stale notes: %+v", reused)
	}
	// A second save on the current input does not certify that the draft was reviewed.
	reused = save("writer", turn.Session.RunID, reused.Content, reused.workflowArtifactRef, workflowArtifactNotes{})
	if reused.ReusedFrom == nil || *reused.ReusedFrom != stable.workflowArtifactRef {
		t.Fatalf("second save erased cross-input provenance: %+v", reused)
	}
	f.finish("writer", turn.Session.RunID, "")

	preview := f.preview("writer", reused.workflowArtifactRef)
	if len(preview.ReuseReviews) != 1 || preview.ConfirmedAt != "" || preview.Artifacts[0].HandedOff {
		t.Fatalf("save and preview must leave reuse unconfirmed: %+v", preview)
	}
	review := preview.ReuseReviews[0]
	if review.workflowArtifactRef != reused.workflowArtifactRef || review.ReusedFrom != stable.workflowArtifactRef ||
		len(review.PreviousInputs) != 1 || review.PreviousInputs[0].HandoffID != original.HandoffID ||
		len(review.CurrentInputs) != 1 || review.CurrentInputs[0].HandoffID != updated.HandoffID ||
		review.PreviousInputs[0].SourceRevision != original.SourceRevision || review.CurrentInputs[0].SourceRevision != updated.SourceRevision {
		t.Fatalf("preview did not show the selected version, reuse source and input change: %+v", review)
	}
	if !slices.Equal(updated.Constraints, []string{"45 秒", "保留普通话对白"}) ||
		!slices.Equal(turn.Inputs[0].Constraints, updated.Constraints) {
		t.Fatalf("the current project constraints must stay with their official input: %+v", turn.Inputs[0])
	}
	confirmed := f.confirm("writer", preview)
	if confirmed.ConfirmedAt == "" || !confirmed.Artifacts[0].HandedOff || len(confirmed.ReuseReviews) != 1 ||
		confirmed.Artifacts[0].Content != draft.Content {
		t.Fatalf("human confirmation failed to attest reuse with unchanged text: %+v", confirmed)
	}
}
