package studio

import (
	"context"
	"net/http"
	"strings"
	"testing"
)

func TestWorkflowSupersededKickoffClearsOnlyObsoletePending(t *testing.T) {
	f := newWorkflowTest(t, nil)
	const topic, analysis = "topic-selection", "content-analysis"
	f.call("a", "human", "workflow_profile_select", workflowProfileArgs{
		operation: workflowOp(), WorkflowProfileID: "short-video",
	})
	approve := func(session, text string) workflowHandoff {
		t.Helper()
		f.activate(session, topic)
		turn := f.start(session, topic, "")
		draft := f.draft(session, turn.Session.RunID, text, workflowArtifact{})
		f.finish(session, turn.Session.RunID, "")
		return f.confirm(session, f.preview(session, draft.workflowArtifactRef))
	}
	failure := func(session, handoff string) workflowSession {
		t.Helper()
		return f.call(session, "workflow", "workflow_kickoff_failed", workflowKickoffFailedArgs{
			operation: workflowOp(), HandoffID: handoff, Error: "Native queue offline",
		}).(workflowSessionResult).Session
	}

	first := approve("a", "first approval")
	if got := failure("a", first.HandoffID); got.PendingHandoffID != first.HandoffID || got.Error != "Native queue offline" {
		t.Fatalf("valid pending failed to remain retryable: %+v", got)
	}
	next := approve("b", "peer approval")
	if got := f.view("a").Session; got.PendingHandoffID != "" || got.Error != workflowKickoffSuperseded {
		t.Fatalf("superseded request was not expired with a reason: %+v", got)
	}
	f.check("a", "workflow", "workflow_turn_start", f.admission("a", analysis, first.HandoffID), http.StatusConflict)
	continued := f.start("a", analysis, "")
	if continued.Session.PendingHandoffID != "" || len(continued.Inputs) != 1 || continued.Inputs[0].HandoffID != next.HandoffID {
		t.Fatalf("ordinary follow-up did not receive the new official input: %+v", continued)
	}
	f.finish("a", continued.Session.RunID, "")

	replacement := approve("a", "fresh same-session approval")
	if got := failure("a", first.HandoffID); got.PendingHandoffID != replacement.HandoffID || got.Error != "" {
		t.Fatalf("late error for old request changed the replacement: %+v", got)
	}

	// Restore the condition a stored Workspace can have before this Host upgrade.
	p, err := f.s.open(context.Background(), f.dir, false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.db.Exec(`UPDATE workflow_sessions SET pending_handoff=? WHERE session_id='b'`, next.HandoffID); err != nil {
		t.Fatal(err)
	}
	f.reopen(nil)
	recovered := f.call("b", "workflow", "workflow_session", map[string]bool{"stateOnly": true}).(workflowSessionResult).Session
	if recovered.PendingHandoffID != "" || recovered.Error != workflowKickoffSuperseded {
		t.Fatalf("state-only retry check did not expire the stored obsolete request: %+v", recovered)
	}
	if got := f.view("a").Session; got.PendingHandoffID != replacement.HandoffID {
		t.Fatalf("recovering a peer expired an unrelated valid request: %+v", got)
	}
}

func TestWorkflowLegacyRequiredInputsMatchPreviewAndAdmission(t *testing.T) {
	f := newWorkflowTest(t, nil)
	const analysis, script, board = "content-analysis", "shooting-script", "storyboard"
	f.activate("early", analysis)
	f.check("early", "human", "workflow_activate", f.activation("early", board, "missing"), http.StatusConflict)

	f.seedLegacyBefore(board)
	f.activate("editor", board)
	initial := f.start("editor", board, "")
	if len(initial.Inputs) != 2 || initial.Inputs[0].SourceStageID != analysis || initial.Inputs[1].SourceStageID != script {
		t.Fatalf("legacy storyboard lost valid formal inputs: %+v", initial.Inputs)
	}
	f.finish("editor", initial.Session.RunID, "")
	p, err := f.s.open(context.Background(), f.dir, false)
	if err != nil {
		t.Fatal(err)
	}
	markStale := func(stage string) {
		t.Helper()
		if _, err := p.db.Exec(`UPDATE workflow_handoffs SET stale=1 WHERE stage_id=?`, stage); err != nil {
			t.Fatal(err)
		}
	}
	markStale(analysis)
	current := f.start("editor", board, "")
	if len(current.Inputs) != 1 || current.Inputs[0].SourceStageID != script {
		t.Fatalf("stale optional reference leaked into the current inputs: %+v", current.Inputs)
	}
	draft := f.draft("editor", current.Session.RunID, "storyboard from the formal script", workflowArtifact{})
	f.finish("editor", current.Session.RunID, "")
	f.preview("editor", draft.workflowArtifactRef)

	markStale(script)
	for _, test := range []struct {
		actor, action string
		args          any
	}{
		{"workflow", "workflow_turn_start", f.admission("editor", board, "")},
		{"human", "workflow_handoff_preview", workflowPreviewArgs{operation: workflowOp()}},
	} {
		if _, err := editCall(f.s, f.dir, "editor", test.actor, test.action, test.args); err == nil ||
			!strings.Contains(err.Error(), "拍摄脚本制作") {
			t.Fatalf("%s did not explain the missing effective script: %v", test.action, err)
		}
	}
}
