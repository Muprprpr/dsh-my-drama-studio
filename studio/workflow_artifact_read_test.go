package studio

import (
	"encoding/json"
	"net/http"
	"strconv"
	"testing"
)

func TestWorkflowArtifactReadsUseTheAdmittedRun(t *testing.T) {
	const topic, analysis, script = "topic-selection", "content-analysis", "shooting-script"
	f := newWorkflowTest(t, nil)
	f.call("owner", "human", "workflow_profile_select", workflowProfileArgs{
		operation: workflowOp(), WorkflowProfileID: "short-video",
	})
	f.activate("owner", topic)
	topicRun := f.start("owner", topic, "").Session.RunID
	v1 := f.draft("owner", topicRun, "approved content", workflowArtifact{})
	v2 := f.draft("owner", topicRun, "unapproved content", v1)

	readArgs := func(run string, ref workflowArtifactRef, scope string) workflowArtifactReadArgs {
		args := workflowArtifactReadArgs{ArtifactID: ref.ArtifactID, RunID: run, Scope: scope}
		if ref.Version != 0 {
			args.Version = json.RawMessage(strconv.FormatInt(ref.Version, 10))
		}
		return args
	}
	read := func(session, run string, ref workflowArtifactRef, scope string) workflowArtifact {
		t.Helper()
		return f.call(session, "workflow", "workflow_artifact_get", readArgs(run, ref, scope)).(workflowArtifact)
	}
	reject := func(session, run string, ref workflowArtifactRef, scope string, code int) {
		t.Helper()
		f.check(session, "workflow", "workflow_artifact_get", readArgs(run, ref, scope), code)
	}
	byID := workflowArtifactRef{ArtifactID: v1.ArtifactID}
	reject("owner", topicRun, byID, "", http.StatusNotFound)
	currentDraft := read("owner", topicRun, byID, "draft")
	if currentDraft.Version != 2 || currentDraft.ReadScope != "draft" {
		t.Fatalf("current draft did not resolve to its head: %+v", currentDraft)
	}
	f.finish("owner", topicRun, "")
	preview := f.preview("owner", v2.workflowArtifactRef)
	approved := f.confirm("owner", f.preview("owner", v1.workflowArtifactRef))
	ownerRun := f.start("owner", analysis, approved.HandoffID).Session.RunID

	got := read("owner", ownerRun, byID, "")
	if got.Content != v1.Content || got.Version != 1 || got.ReadScope != "input" ||
		got.HandoffStatus != "current" || got.HandoffID != approved.HandoffID || !got.HandedOff {
		t.Fatalf("default lookup chose an unapproved version or lost its status: %+v", got)
	}
	reject("owner", ownerRun, v2.workflowArtifactRef, "", http.StatusNotFound)
	for _, invalidVersion := range []string{"0", "null"} {
		args := readArgs(ownerRun, byID, "")
		args.Version = json.RawMessage(invalidVersion)
		f.check("owner", "workflow", "workflow_artifact_get", args, http.StatusBadRequest)
	}
	reject("owner", ownerRun, byID, "reference", http.StatusBadRequest)
	reject("owner", ownerRun, byID, "draft", http.StatusNotFound)
	reference := read("owner", ownerRun, v2.workflowArtifactRef, "reference")
	if reference.Content != v2.Content || reference.ReadScope != "reference" || reference.HandedOff ||
		reference.HandoffStatus != "preview" || reference.HandoffID != preview.HandoffID {
		t.Fatalf("preview must be readable only as reference: %+v", reference)
	}
	reject("peer", ownerRun, v1.workflowArtifactRef, "", http.StatusForbidden)
	reject("owner", "", v1.workflowArtifactRef, "", http.StatusForbidden)

	f.activate("peer", analysis)
	peerRun := f.start("peer", analysis, "").Session.RunID
	reject("peer", peerRun, v2.workflowArtifactRef, "reference", http.StatusNotFound)

	analysisDraft := f.draft("owner", ownerRun, "analysis under V1", workflowArtifact{})
	f.finish("owner", ownerRun, "")
	reject("owner", ownerRun, byID, "", http.StatusForbidden)
	analysisHandoff := f.confirm("owner", f.preview("owner", analysisDraft.workflowArtifactRef))
	scriptRun := f.start("owner", script, analysisHandoff.HandoffID).Session.RunID
	if gotTopic, gotAnalysis := read("owner", scriptRun, byID, ""), read("owner", scriptRun,
		workflowArtifactRef{ArtifactID: analysisDraft.ArtifactID}, ""); gotTopic.HandoffID != approved.HandoffID ||
		gotAnalysis.HandoffID != analysisHandoff.HandoffID {
		t.Fatalf("run lost approved input from one of its predecessors: %+v / %+v", gotTopic, gotAnalysis)
	}
	f.finish("owner", scriptRun, "")

	f.activate("owner", topic)
	v2Handoff := f.confirm("owner", f.preview("owner", v2.workflowArtifactRef))
	got = read("peer", peerRun, byID, "")
	if got.Content != v1.Content || got.ReadScope != "input" || got.HandoffStatus != "superseded" || !got.HandedOff {
		t.Fatalf("peer run silently changed its fixed formal input: %+v", got)
	}
	reject("peer", peerRun, v2.workflowArtifactRef, "input", http.StatusNotFound)
	f.finish("peer", peerRun, "")

	next := f.start("peer", analysis, "").Session.RunID
	got = read("peer", next, byID, "")
	if got.Content != v2.Content || got.Version != 2 || got.HandoffID != v2Handoff.HandoffID || got.HandoffStatus != "current" {
		t.Fatalf("next run did not take the new confirmed input: %+v", got)
	}
	reject("peer", next, v1.workflowArtifactRef, "", http.StatusNotFound)
	reference = read("peer", next, v1.workflowArtifactRef, "reference")
	if reference.ReadScope != "reference" || reference.HandoffStatus != "superseded" || !reference.HandedOff {
		t.Fatalf("historical reference lost its original confirmation or appears formal: %+v", reference)
	}
	stale := read("peer", next, analysisDraft.workflowArtifactRef, "reference")
	if stale.ReadScope != "reference" || stale.HandoffStatus != "stale" || !stale.HandedOff {
		t.Fatalf("stale handoff must remain historically confirmed: %+v", stale)
	}
	human := f.call("peer", "human", "workflow_artifact_get", v1.workflowArtifactRef).(workflowArtifact)
	if human.Content != v1.Content || !human.HandedOff || human.HandoffStatus != "superseded" {
		t.Fatalf("human cannot read the exact historical approval: %+v", human)
	}
	f.finish("peer", next, "")
}
