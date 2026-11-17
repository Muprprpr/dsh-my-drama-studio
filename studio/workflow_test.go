package studio

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func workflowTestSnapshot(stageID, version string) *workflowSnapshot {
	return profileTestSnapshot(legacyWorkflowProfile, stageID, version)
}

func profileTestSnapshot(profile *workflowProfile, stageID, version string) *workflowSnapshot {
	if stageID == "" {
		return nil
	}
	stage := profile.stage(profile.stageIndex(stageID))
	skillBody, harnessBody := "Rendered "+stageID+" Skill "+version, stageID+" Harness "+version
	return &workflowSnapshot{
		WorkflowProfileID: profile.ID, WorkflowDefinitionVersion: profile.Version, SkillID: stage.Skill,
		StageID: stageID, SkillBody: skillBody, HarnessBody: harnessBody,
		SkillPath:         "skills/" + stage.Skill + "/SKILL.md",
		HarnessPath:       "drama-studio/workflows/" + dramaWorkflowID + "/" + stage.Harness,
		SkillSourceSHA256: workflowDigest([]byte("Raw " + stageID + " Skill " + version)),
		workflowFileVersions: workflowFileVersions{
			SkillSHA256: workflowDigest([]byte(skillBody)), HarnessSHA256: workflowDigest([]byte(harnessBody)),
		},
	}
}

func workflowStageIndex(id string) int { return legacyWorkflowProfile.stageIndex(id) }

func workflowOp() operation { return operation{ID: uuid.NewString()} }

type workflowTest struct {
	t   *testing.T
	s   *Service
	dir string
}

func newWorkflowTest(t *testing.T, providers providerRegistry) *workflowTest {
	f := &workflowTest{t: t, s: New(providers), dir: t.TempDir()}
	t.Cleanup(func() { _ = f.s.Close() })
	return f
}

func (f *workflowTest) call(session, actor, action string, data any) any {
	f.t.Helper()
	value, err := editCall(f.s, f.dir, session, actor, action, data)
	if err != nil {
		f.t.Fatalf("%s/%s: %v", session, action, err)
	}
	return value
}

func (f *workflowTest) check(session, actor, action string, data any, code int) {
	f.t.Helper()
	_, err := editCall(f.s, f.dir, session, actor, action, data)
	var known *requestError
	if !errors.As(err, &known) || known.code != code {
		f.t.Fatalf("%s/%s: got %v, expected HTTP %d", session, action, err, code)
	}
}

func (f *workflowTest) view(session string) workflowView {
	f.t.Helper()
	return f.call(session, "human", "workflow_get", nil).(workflowView)
}

func (f *workflowTest) activate(session, stage string) workflowView {
	f.t.Helper()
	return f.call(session, "human", "workflow_activate", f.activation(session, stage, "V1")).(workflowView)
}

func (f *workflowTest) activation(session, stage, version string) workflowActivateArgs {
	f.t.Helper()
	view := f.view(session)
	if view.ProfileSelectionRequired {
		if _, err := f.s.Execute(context.Background(), Request{
			WorkspaceID: "workspace", WorkspacePath: f.dir, Action: "recover",
			Data: json.RawMessage(`{"legacyWorkspace":true}`),
		}); err != nil {
			f.t.Fatal(err)
		}
		view = f.view(session)
	}
	activation := view.Session.Activation
	return workflowActivateArgs{operation: workflowOp(), StageID: stage,
		ExpectedActivation: &activation, Snapshot: profileTestSnapshot(workflowProfiles[view.WorkflowProfileID], stage, version)}
}

func (f *workflowTest) start(session, stage, handoff string) workflowTurnResult {
	f.t.Helper()
	return f.call(session, "workflow", "workflow_turn_start", f.admission(session, stage, handoff)).(workflowTurnResult)
}

func (f *workflowTest) admission(session, stage, handoff string) workflowTurnStartArgs {
	f.t.Helper()
	current := f.view(session).Session
	return workflowTurnStartArgs{operation: workflowOp(), RunID: uuid.NewString(), StageID: stage,
		HandoffID: handoff, Activation: current.Activation, SnapshotID: current.SnapshotID}
}

func (f *workflowTest) finish(session, run, reason string) {
	f.t.Helper()
	f.call(session, "workflow", "workflow_turn_finish", workflowTurnFinishArgs{operation: workflowOp(), RunID: run, Error: reason})
}

func (f *workflowTest) draft(session, run, text string, prior workflowArtifact) workflowArtifact {
	f.t.Helper()
	return f.call(session, "workflow", "workflow_save_artifact", workflowSaveArtifactArgs{
		operation: workflowOp(), RunID: run, ArtifactID: prior.ArtifactID, ExpectedVersion: prior.Version,
		Title: "分镜脚本", Content: text, workflowArtifactNotes: workflowArtifactNotes{
			Summary: "首镜从室外切入", ConfirmedDecisions: []string{"先全景再切近"}, Constraints: []string{"横屏"}},
	}).(workflowArtifact)
}

func (f *workflowTest) preview(session string, refs ...workflowArtifactRef) workflowHandoff {
	f.t.Helper()
	return f.call(session, "human", "workflow_handoff_preview", workflowPreviewArgs{
		operation: workflowOp(), Artifacts: refs,
	}).(workflowHandoff)
}

func (f *workflowTest) confirm(session string, h workflowHandoff) workflowHandoff {
	f.t.Helper()
	return f.call(session, "human", "workflow_handoff_confirm", workflowConfirmArgs{
		operation: workflowOp(), HandoffID: h.HandoffID,
		Snapshot: profileTestSnapshot(workflowProfiles[f.view(session).WorkflowProfileID], h.TargetStageID, "V1"),
	}).(workflowHandoffConfirmation).Handoff
}

func (f *workflowTest) reopen(providers providerRegistry) {
	f.t.Helper()
	if err := f.s.Close(); err != nil {
		f.t.Fatal(err)
	}
	f.s = New(providers)
}

func (f *workflowTest) seedLegacyBefore(target string) {
	f.t.Helper()
	const session = "prerequisite-fixture"
	stages := legacyWorkflowProfile.Stages[:legacyWorkflowProfile.stageIndex(target)]
	f.activate(session, stages[0].ID)
	for _, stage := range stages {
		turn := f.start(session, stage.ID, f.view(session).Session.PendingHandoffID)
		f.draft(session, turn.Session.RunID, stage.Name+" 前置夹具", workflowArtifact{})
		f.finish(session, turn.Session.RunID, "")
		f.confirm(session, f.preview(session))
	}
}

func TestWorkflowSessionDraftsAndExplicitHandoff(t *testing.T) {
	f := newWorkflowTest(t, nil)
	const stage = "content-analysis"
	const target = "shooting-script"
	idx := workflowStageIndex(stage)
	if v := f.view("normal"); v.Session.Status != "normal" || !v.ProfileSelectionRequired || len(v.Stages) != 0 {
		t.Fatalf("initial workflow: %+v", v)
	}
	if _, err := os.Stat(filepath.Join(f.dir, ".drama-studio")); !os.IsNotExist(err) {
		t.Fatalf("reading normal chat created project state: %v", err)
	}
	if v := f.activate("a", stage); v.Session.Status != "active" || v.Session.ActiveStageID != stage || len(v.Handoffs) != 0 ||
		len(v.Stages) != 7 || v.Stages[idx].Status != workflowNotStarted {
		t.Fatalf("activation started work or handoff: %+v", v)
	}
	f.activate("b", stage)
	turnA := f.start("a", stage, "")
	turnB := f.start("b", stage, "")
	if turnA.Session.Status != workflowRunning || turnB.Session.Status != workflowRunning || len(turnA.Inputs) != 0 {
		t.Fatalf("independent runs: %+v / %+v", turnA, turnB)
	}
	if v := f.view("normal"); v.Session.Status != "normal" || v.Session.ActiveStageID != "" {
		t.Fatalf("peer activation affected ordinary chat: %+v", v.Session)
	}
	a1 := f.draft("a", turnA.Session.RunID, "分镜初稿", workflowArtifact{})
	b1 := f.draft("b", turnB.Session.RunID, "B 的不共享草稿", workflowArtifact{})
	f.check("a", "workflow", "workflow_save_artifact", workflowSaveArtifactArgs{
		operation: workflowOp(), RunID: turnB.Session.RunID, Title: "越权", Content: "无效"}, http.StatusForbidden)
	f.check("b", "workflow", "workflow_artifact_get", map[string]any{
		"artifactId": a1.ArtifactID, "version": a1.Version, "runId": turnB.Session.RunID, "scope": "reference",
	}, http.StatusNotFound)
	f.finish("a", turnA.Session.RunID, "")
	f.finish("b", turnB.Session.RunID, "")
	{
		prior := a1
		turn := f.start("a", stage, "")
		if len(turn.Artifacts) != 1 || turn.Artifacts[0].Version != prior.Version {
			t.Fatalf("round two lost the prior draft: %+v", turn.Artifacts)
		}
		a2 := f.call("a", "workflow", "workflow_save_artifact", workflowSaveArtifactArgs{
			operation: workflowOp(), RunID: turn.Session.RunID, ArtifactID: prior.ArtifactID,
			ExpectedVersion: prior.Version, Title: prior.Title, Content: "分镜第二版",
		}).(workflowArtifact)
		if len(a2.ConfirmedDecisions) != 1 || len(a2.Constraints) != 1 {
			t.Fatalf("unrelated revision lost decisions or constraints: %+v", a2)
		}
		f.finish("a", turn.Session.RunID, "")
		stalePreview := f.preview("a")
		turn = f.start("a", stage, "")
		a3 := f.draft("a", turn.Session.RunID, "分镜第三版", a2)
		f.finish("a", turn.Session.RunID, "")
		f.check("a", "human", "workflow_handoff_confirm", workflowConfirmArgs{
			operation: workflowOp(), HandoffID: stalePreview.HandoffID}, http.StatusConflict)
		v := f.view("a")
		if len(v.Artifacts) != 3 || v.Artifacts[0].Content != a3.Content || v.Artifacts[2].Content != a1.Content ||
			v.Stages[idx].Status != workflowDraft || len(v.Handoffs) != 0 || v.Session.ActiveStageID != stage {
			t.Fatalf("iteration changed formal progress or lost versions: %+v", v)
		}
	}
	if v := f.view("b"); len(v.Artifacts) != 1 || v.Artifacts[0].ArtifactID != b1.ArtifactID || v.Stages[idx].Status != workflowDraft {
		t.Fatalf("drafts were not owned independently: %+v", v)
	}
	bindSession(t, f.s, f.dir, "a")
	if nodes := mustCall(t, f.s, f.dir, "a", "query", nil).(queryResult).Nodes; len(nodes) != 0 {
		t.Fatalf("document work created Canvas nodes: %+v", nodes)
	}
	aPreview := f.preview("a", a1.workflowArtifactRef)
	bPreview := f.preview("b")
	f.check("a", "workflow", "workflow_activate", workflowActivateArgs{operation: workflowOp(), StageID: "final-review"}, http.StatusForbidden)
	f.check("a", "workflow", "workflow_handoff_preview", workflowPreviewArgs{operation: workflowOp()}, http.StatusForbidden)
	f.check("a", "workflow", "workflow_handoff_confirm", workflowConfirmArgs{
		operation: workflowOp(), HandoffID: aPreview.HandoffID}, http.StatusForbidden)
	targetQuery := map[string]string{"handoffId": aPreview.HandoffID}
	if result := f.call("a", "workflow", "workflow_handoff_target", targetQuery).(workflowHandoffTarget); result.TargetStage == nil || result.TargetStage.ID != target {
		t.Fatalf("wrong handoff target: %+v", result)
	}
	f.check("b", "workflow", "workflow_handoff_target", targetQuery, http.StatusConflict)
	f.check("a", "human", "workflow_handoff_confirm", workflowConfirmArgs{
		operation: workflowOp(), HandoffID: aPreview.HandoffID,
	}, http.StatusBadRequest)
	if v := f.view("a"); v.Session.ActiveStageID != stage || len(v.Handoffs) != 0 {
		t.Fatalf("missing target snapshot partially confirmed a handoff: %+v", v)
	}
	confirm := workflowConfirmArgs{operation: workflowOp(), HandoffID: aPreview.HandoffID, Snapshot: workflowTestSnapshot(target, "V1")}
	confirmed := f.call("a", "human", "workflow_handoff_confirm", confirm).(workflowHandoffConfirmation)
	a := confirmed.Handoff
	if !confirmed.Committed {
		t.Fatal("first confirmation did not commit")
	}
	if out := f.call("a", "workflow", "workflow_handoff_target", targetQuery).(workflowHandoffTarget); out.TargetStage != nil {
		t.Fatalf("confirmed replay should not need target files: %+v", out)
	}
	confirm.Snapshot = nil
	for _, operationID := range []operation{confirm.operation, workflowOp()} {
		confirm.operation = operationID
		replayed := f.call("a", "human", "workflow_handoff_confirm", confirm).(workflowHandoffConfirmation)
		if replayed.Committed || a.HandoffID != replayed.Handoff.HandoffID || a.ConfirmedAt != replayed.Handoff.ConfirmedAt {
			t.Fatalf("confirmation replay committed or changed the receipt: %+v", replayed)
		}
	}
	f.check("b", "human", "workflow_handoff_confirm", workflowConfirmArgs{
		operation: workflowOp(), HandoffID: bPreview.HandoffID}, http.StatusConflict)
	if a.ConfirmedAt == "" || a.TargetStageID != target || a.SourceRevision != 1 || a.Artifacts[0].Content != a1.Content ||
		len(a.ConfirmedDecisions) != 1 || len(a.Constraints) != 1 {
		t.Fatalf("incorrect pinned package: %+v", a)
	}
	if v := f.view("b"); len(v.Handoffs) != 1 || v.Stages[idx].Status != workflowHandedOff || v.Session.ActiveStageID != stage ||
		len(v.Artifacts) != 2 || !v.Artifacts[1].HandedOff {
		t.Fatalf("formal data not shared or peer Session changed: %+v", v)
	}
	f.reopen(nil)
	if v := f.view("a"); len(v.Handoffs) != 1 || len(v.Artifacts) != 3 || v.Session.ActiveStageID != target ||
		v.Session.PendingHandoffID != a.HandoffID || v.Session.Status != "active" || !v.Session.TransitionPending || v.Session.SnapshotID == "" {
		t.Fatalf("restart changed formal package, draft history or initial delivery: %+v", v)
	}
	f.call("a", "workflow", "workflow_kickoff_failed", workflowKickoffFailedArgs{
		operation: workflowOp(), HandoffID: a.HandoffID, Error: "Native queue offline",
	})
	if ses := f.view("a").Session; ses.Status != workflowFailed || ses.PendingHandoffID != a.HandoffID {
		t.Fatalf("initial delivery failure discarded pending result: %+v", ses)
	}
	initial := f.start("a", target, a.HandoffID)
	if len(initial.Inputs) != 1 || initial.Inputs[0].Artifacts[0].Content != a1.Content ||
		initial.Session.PendingHandoffID != "" || initial.Session.SkillSHA256 != workflowTestSnapshot(target, "V1").SkillSHA256 {
		t.Fatalf("initial turn missed exact approved input: %+v", initial)
	}
	f.draft("a", initial.Session.RunID, "素材说明", workflowArtifact{})
	f.finish("a", initial.Session.RunID, "")
	f.check("a", "workflow", "workflow_turn_start", f.admission("a", target, a.HandoffID), http.StatusConflict)
	binding := f.confirm("a", f.preview("a"))
	b := f.confirm("b", f.preview("b"))
	if b.SourceRevision <= binding.SourceRevision || f.view("normal").Stages[workflowStageIndex(target)].Status != workflowStale {
		t.Fatalf("new upstream version did not invalidate downstream: %+v", f.view("normal"))
	}
}

func TestWorkflowWorkspaceIsolationAndAbandonedTurnRecovery(t *testing.T) {
	f := newWorkflowTest(t, nil)
	other := newWorkflowTest(t, nil)
	f.activate("one", "content-analysis")
	other.call("one", "human", "workflow_profile_select", workflowProfileArgs{
		operation: workflowOp(), WorkflowProfileID: "short-drama",
	})
	other.activate("one", "shooting-script")
	turn := f.start("one", "content-analysis", "")
	f.draft("one", turn.Session.RunID, "工作区 A", workflowArtifact{})
	peer := New(nil)
	defer peer.Close()
	value, err := editCall(peer, f.dir, "one", "workflow", "workflow_session", nil)
	if err != nil || value.(workflowSessionResult).Session.Status != workflowRunning {
		t.Fatalf("second kernel marked the live native turn abandoned: %v %v", value, err)
	}
	if v := other.view("one"); v.Session.ActiveStageID != "shooting-script" || len(v.Artifacts) != 0 {
		t.Fatalf("cross-workspace state leak: %+v", v)
	}
	f.reopen(nil)
	if v := f.view("one"); v.Session.Status != workflowFailed || v.Session.ActiveStageID != "content-analysis" ||
		len(v.Artifacts) != 1 || len(v.Handoffs) != 0 {
		t.Fatalf("interrupted native run changed active stage, drafts or formal progress: %+v", v)
	}
	resumed := f.start("one", "content-analysis", "")
	f.check("one", "human", "workflow_activate", f.activation("one", "shooting-script", "V1"), http.StatusConflict)
	f.check("one", "human", "workflow_activate", f.activation("one", "", ""), http.StatusConflict)
	if peerSession := f.activate("peer", "content-analysis").Session; peerSession.ActiveStageID != "content-analysis" {
		t.Fatalf("running Session blocked a peer's activation: %+v", peerSession)
	}
	f.finish("one", resumed.Session.RunID, "Old turn failed")
	f.activate("one", "")
	f.activate("one", "content-analysis")
	if v := f.view("one"); v.Session.Status != "active" || v.Session.ActiveStageID != "content-analysis" || len(v.Artifacts) != 1 {
		t.Fatalf("old attempt overwrote the new activation: %+v", v)
	}
	if v := f.activate("one", ""); v.Session.Status != "normal" || len(v.Artifacts) != 1 {
		t.Fatalf("exit activated work or removed existing drafts: %+v", v)
	}
}

func TestWorkflowFrozenSnapshotAndExactTransition(t *testing.T) {
	f := newWorkflowTest(t, nil)
	const stage = "content-analysis"
	v1 := f.activate("a", stage)
	if v1.Snapshot != nil || v1.Session.SnapshotID == "" || v1.Session.Activation != 1 ||
		v1.Session.ActivatedAt == "" || !v1.Session.TransitionPending {
		t.Fatalf("expected browser metadata without private snapshot body: %+v", v1.workflowSessionResult)
	}
	f.check("a", "human", "workflow_session", nil, http.StatusForbidden)
	read := func(id string) workflowSessionResult {
		return f.call(id, "workflow", "workflow_session", nil).(workflowSessionResult)
	}
	stateOnly := f.call("a", "workflow", "workflow_session", map[string]bool{"stateOnly": true}).(workflowSessionResult)
	if stateOnly.Snapshot != nil || stateOnly.Session != v1.Session {
		t.Fatalf("state-only read changed activation metadata: %+v", stateOnly)
	}
	dedup := f.activate("dedup", stage)
	if dedup.Session.SnapshotID != v1.Session.SnapshotID {
		t.Fatal("identical contents did not reuse their snapshot")
	}
	repeated := f.call("a", "human", "workflow_activate", f.activation("a", stage, "V2")).(workflowView)
	if repeated.Session != v1.Session || *read("a").Snapshot != *workflowTestSnapshot(stage, "V1") {
		t.Fatalf("same-stage click replaced the frozen activation: %+v", repeated.Session)
	}
	fresh := f.call("b", "human", "workflow_activate", f.activation("b", stage, "V2")).(workflowView)
	if fresh.Session.SnapshotID == v1.Session.SnapshotID || *read("b").Snapshot != *workflowTestSnapshot(stage, "V2") {
		t.Fatalf("new activation failed to use its own version: %+v", fresh.Session)
	}
	failed := f.start("a", stage, "")
	f.finish("a", failed.Session.RunID, "Cancelled")
	if !read("a").Session.TransitionPending {
		t.Fatal("failed turn released the transition")
	}
	abandoned := f.start("a", stage, "")
	f.reopen(nil)
	restored := read("a")
	if !restored.Session.TransitionPending || restored.Session.Status != workflowFailed ||
		restored.Session.RunID != "" || restored.Session.SnapshotID != v1.Session.SnapshotID ||
		*restored.Snapshot != *workflowTestSnapshot(stage, "V1") {
		t.Fatalf("restart lost the pending transition, snapshot, or run recovery: %+v", restored)
	}
	p, err := f.s.open(context.Background(), f.dir, false)
	if err != nil {
		t.Fatal(err)
	}
	var snapshotID, skillSHA, harnessSHA, status string
	if err := p.db.QueryRow(`SELECT snapshot_id,skill_sha,harness_sha,status FROM workflow_turns WHERE id=?`, abandoned.Session.RunID).
		Scan(&snapshotID, &skillSHA, &harnessSHA, &status); err != nil || snapshotID != v1.Session.SnapshotID ||
		skillSHA != v1.Session.SkillSHA256 || harnessSHA != v1.Session.HarnessSHA256 || status != workflowFailed {
		t.Fatalf("interrupted turn lost its provenance: %s %s %s %s / %v", snapshotID, skillSHA, harnessSHA, status, err)
	}
	var snapshotCount int
	if err := p.db.QueryRow(`SELECT count(*) FROM workflow_capability_snapshots`).Scan(&snapshotCount); err != nil || snapshotCount != 2 {
		t.Fatalf("unexpected number of stored versions: %d / %v", snapshotCount, err)
	}
	transition := func(activation int64) workflowSession {
		return f.call("a", "workflow", "workflow_transition_complete", workflowTransitionArgs{
			operation: workflowOp(), Activation: activation,
		}).(workflowSessionResult).Session
	}
	ready := f.start("a", stage, "")
	f.finish("a", ready.Session.RunID, "")
	if transition(v1.Session.Activation).TransitionPending || !read("b").Session.TransitionPending {
		t.Fatal("transition completion missed its own generation or touched a peer Session")
	}
	exit := f.activate("a", "").Session
	if exit.Activation != v1.Session.Activation+1 || !exit.TransitionPending ||
		exit.ActiveStageID != "" || exit.SnapshotID != "" {
		t.Fatalf("exit must create a guarded normal activation: %+v", exit)
	}
	if !transition(v1.Session.Activation).TransitionPending {
		t.Fatal("late stage completion cleared the exit barrier")
	}
	f.reopen(nil)
	if !read("a").Session.TransitionPending || transition(exit.Activation).TransitionPending {
		t.Fatal("normal-chat transition did not survive restart or clear on exact generation")
	}
	reactivated := f.call("a", "human", "workflow_activate", f.activation("a", stage, "V2")).(workflowView).Session
	if reactivated.Activation != exit.Activation+1 || reactivated.SnapshotID != fresh.Session.SnapshotID ||
		!reactivated.TransitionPending {
		t.Fatalf("reactivation did not use the new snapshot: %+v", reactivated)
	}
	f.call("a", "workflow", "workflow_turn_failed", workflowTurnFailedArgs{
		operation: workflowOp(), StageID: stage, Activation: v1.Session.Activation, Error: "late old failure",
	})
	if got := read("a").Session; got != reactivated {
		t.Fatalf("late failure affected a newer activation of the same stage: %+v", got)
	}
}

func TestWorkflowConcurrentStageSwitchAndTurnAdmission(t *testing.T) {
	f := newWorkflowTest(t, nil)
	f.seedLegacyBefore("asset-binding")
	initial := f.activate("session", "storyboard").Session
	admission := f.admission("session", "storyboard", "")
	switchStage := f.activation("session", "asset-binding", "V1")
	peer := New(nil)
	defer peer.Close()
	ready := make(chan struct{})
	started, switched := make(chan error, 1), make(chan error, 1)
	go func() {
		<-ready
		_, err := editCall(f.s, f.dir, "session", "workflow", "workflow_turn_start", admission)
		started <- err
	}()
	go func() {
		<-ready
		_, err := editCall(peer, f.dir, "session", "human", "workflow_activate", switchStage)
		switched <- err
	}()
	close(ready)
	startErr, switchErr := <-started, <-switched
	cur := f.view("session").Session
	var conflict *requestError
	switch {
	case startErr == nil && errors.As(switchErr, &conflict) && conflict.code == http.StatusConflict:
		if cur.RunID != admission.RunID || cur.Activation != initial.Activation || cur.ActiveStageID != initial.ActiveStageID {
			t.Fatalf("admitted turn lost its activation: %+v", cur)
		}
		f.finish("session", admission.RunID, "")
	case switchErr == nil && errors.As(startErr, &conflict) && conflict.code == http.StatusConflict:
		if cur.RunID != "" || cur.Activation != initial.Activation+1 || cur.ActiveStageID != switchStage.StageID {
			t.Fatalf("switched stage admitted a stale turn: %+v", cur)
		}
	default:
		t.Fatalf("expected exactly one atomic winner, got start=%v switch=%v", startErr, switchErr)
	}
}

func TestWorkflowActivationRollsBackStagedSnapshot(t *testing.T) {
	f := newWorkflowTest(t, nil)
	bindSession(t, f.s, f.dir, "session")
	p, err := f.s.open(context.Background(), f.dir, false)
	if err != nil {
		t.Fatal(err)
	}
	bad := f.activation("session", "content-analysis", "V1")
	bad.Snapshot.SkillPath = "skills/../other.md"
	f.check("session", "human", "workflow_activate", bad, http.StatusBadRequest)
	bad = f.activation("session", "content-analysis", "V1")
	bad.Snapshot.SkillBody += " altered"
	f.check("session", "human", "workflow_activate", bad, http.StatusBadRequest)

	// Abort after SQLite has staged both the snapshot and the activation.
	if _, err := p.db.Exec(`CREATE TRIGGER reject_activation_event BEFORE INSERT ON events
		WHEN NEW.type='workflow' BEGIN SELECT RAISE(ABORT, 'interrupted activation fixture'); END`); err != nil {
		t.Fatal(err)
	}
	activation := f.activation("session", "content-analysis", "V1")
	if _, err := editCall(f.s, f.dir, "session", "human", "workflow_activate", activation); err == nil ||
		!strings.Contains(err.Error(), "interrupted activation fixture") {
		t.Fatalf("expected a failed activation transaction: %v", err)
	}
	f.reopen(nil)
	if view := f.view("session"); view.Session.Activation != 0 || view.Session.SnapshotID != "" ||
		view.Session.ActiveStageID != "" || view.Session.TransitionPending {
		t.Fatalf("interrupted activation leaked changed phase state: %+v", view.Session)
	}
	p, err = f.s.open(context.Background(), f.dir, false)
	if err != nil {
		t.Fatal(err)
	}
	var count int
	if err := p.db.QueryRow(`SELECT count(*) FROM workflow_capability_snapshots`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("interrupted activation leaked a staged snapshot: %d / %v", count, err)
	}
	if _, err := p.db.Exec(`DROP TRIGGER reject_activation_event`); err != nil {
		t.Fatal(err)
	}
	if retry := f.call("session", "human", "workflow_activate", activation).(workflowView); retry.Session.SnapshotID == "" {
		t.Fatal("retry could not use original operation ID after rollback")
	}
}

func TestWorkflowActivationMigrationRetainsLegacyMetadata(t *testing.T) {
	f := newWorkflowTest(t, nil)
	bindSession(t, f.s, f.dir, "legacy")
	p, err := f.s.open(context.Background(), f.dir, false)
	if err != nil {
		t.Fatal(err)
	}
	legacyVersions := workflowTestSnapshot("storyboard", "old").workflowFileVersions
	if _, err := p.db.Exec(`DELETE FROM workflow_migrations WHERE name IN ('activation-snapshots-v1','workspace-profiles-v1');
		DROP TABLE workflow_profile;
		ALTER TABLE workflow_sessions DROP COLUMN snapshot_id;
		ALTER TABLE workflow_sessions DROP COLUMN activated_at;
		ALTER TABLE workflow_sessions DROP COLUMN transition_pending;
		ALTER TABLE workflow_turns DROP COLUMN snapshot_id;
		DROP TABLE workflow_capability_snapshots;
		INSERT INTO workflow_sessions(session_id,stage_id,activation,skill_sha,harness_sha)
			VALUES('legacy','storyboard',3,?,?),('already-exited','',4,'','');
		INSERT INTO workflow_turns(id,session_id,stage_id,activation,status,input_key,skill_sha,harness_sha,started_at)
			VALUES('legacy-turn','legacy','storyboard',3,'running','',?,?,'unknown');`,
		legacyVersions.SkillSHA256, legacyVersions.HarnessSHA256, legacyVersions.SkillSHA256, legacyVersions.HarnessSHA256); err != nil {
		t.Fatal(err)
	}
	f.reopen(nil)
	legacy := f.call("legacy", "workflow", "workflow_session", nil).(workflowSessionResult)
	if legacy.WorkflowProfileID != legacyWorkflowProfileID || !legacy.Session.LegacyActivation || !legacy.Session.TransitionPending || legacy.Session.Activation != 3 ||
		legacy.Session.ActiveStageID != "storyboard" || legacy.Session.workflowFileVersions != legacyVersions ||
		legacy.Session.SnapshotID != "" || legacy.Snapshot != nil || legacy.Session.RunID != "" {
		t.Fatalf("migration changed legacy activation or manufactured a snapshot: %+v", legacy)
	}
	if exited := f.view("already-exited").Session; exited.Activation != 4 || !exited.TransitionPending ||
		exited.ActiveStageID != "" || exited.LegacyActivation {
		t.Fatalf("exited legacy Session was not protected conservatively: %+v", exited)
	}
	f.check("legacy", "human", "workflow_activate", f.activation("legacy", "storyboard", "V1"), http.StatusConflict)
	exit := f.activate("legacy", "")
	if exit.Session.Activation != 4 || !exit.Session.TransitionPending {
		t.Fatalf("legacy exit did not start a new protected generation: %+v", exit.Session)
	}
	active := f.activate("legacy", "content-analysis")
	if active.Session.Activation != 5 || active.Session.SnapshotID == "" || active.Session.LegacyActivation {
		t.Fatalf("legacy Session could not explicitly adopt a new snapshot: %+v", active.Session)
	}
}

func TestWorkflowConcurrentConfirmation(t *testing.T) {
	f := newWorkflowTest(t, nil)
	previews := make(map[string]workflowHandoff)
	for _, session := range []string{"a", "b"} {
		f.activate(session, "content-analysis")
		run := f.start(session, "content-analysis", "")
		f.draft(session, run.Session.RunID, session, workflowArtifact{})
		f.finish(session, run.Session.RunID, "")
		previews[session] = f.preview(session)
	}
	otherKernel := New(nil)
	defer otherKernel.Close()
	ready := make(chan struct{})
	result := make(chan error, 2)
	for session, h := range previews {
		go func(session string, handoff workflowHandoff) {
			<-ready
			kernel := f.s
			if session == "b" {
				kernel = otherKernel
			}
			_, err := editCall(kernel, f.dir, session, "human", "workflow_handoff_confirm", workflowConfirmArgs{
				operation: workflowOp(), HandoffID: handoff.HandoffID, Snapshot: workflowTestSnapshot(handoff.TargetStageID, "V1"),
			})
			result <- err
		}(session, h)
	}
	close(ready)
	first, second := <-result, <-result
	if first != nil {
		first, second = second, first
	}
	if first != nil || second != workflowHandoffPeerConfirmed || len(f.view("peer").Handoffs) != 1 {
		t.Fatalf("expected one success and one version conflict across kernels: %v %v", first, second)
	}
}

func TestWorkflowLegacyApprovalMigration(t *testing.T) {
	ctx := context.Background()
	f := newWorkflowTest(t, nil)
	bindSession(t, f.s, f.dir, "legacy-agent")
	node := mustCall(t, f.s, f.dir, "legacy-agent", "append", appendArgs{operation: workflowOp(), Nodes: []NodeInput{
		{Type: "note", Content: json.RawMessage(`{"title":"旧文档","text":"既有分镜"}`)},
	}}).(appendResult).IDs[0]
	p, err := f.s.open(ctx, f.dir, false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.db.ExecContext(ctx, `DELETE FROM workflow_migrations WHERE name='formal-handoffs-v1'`); err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(legacyWorkflowRun{WorkflowID: dramaWorkflowID, WorkspaceID: "native-workspace",
		Approvals: []workflowApproval{
			{ID: "older", At: "2026-11-12T00:00:00Z", Outputs: []workflowRef{{node, 1}}},
			{ID: "newer", At: "2026-11-13T00:00:00Z", Outputs: []workflowRef{{node, 2}}},
		}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.db.ExecContext(ctx, `INSERT INTO workflow_runs VALUES('legacy','content-analysis','legacy-agent','approved',?)`, string(encoded)); err != nil {
		t.Fatal(err)
	}
	f.reopen(nil)
	view := f.activate("viewer", "shooting-script")
	if len(view.Handoffs) != 2 || len(view.Inputs) != 1 || view.Inputs[0].HandoffID != "newer" ||
		view.Handoffs[0].Artifacts[0].Node.Revision != 2 || string(view.Handoffs[0].Artifacts[0].Node.Content) != "null" ||
		!strings.Contains(string(view.Handoffs[1].Artifacts[0].Node.Content), "既有分镜") {
		t.Fatalf("legacy approvals or exact historical reference changed: %+v", view)
	}
	f.reopen(nil)
	if v := f.view("viewer"); v.Session.ActiveStageID != "shooting-script" || len(v.Handoffs) != 2 {
		t.Fatalf("migration replayed legacy approvals: %+v", v)
	}
}

func TestWorkflowVideoUsesAuthorizedExactResults(t *testing.T) {
	ctx := context.Background()
	f := newWorkflowTest(t, providerFixture{})
	f.seedLegacyBefore(workflowDeployment)
	bindSession(t, f.s, f.dir, "active")
	bindSession(t, f.s, f.dir, "human")
	p, err := f.s.open(ctx, f.dir, false)
	if err != nil {
		t.Fatal(err)
	}
	node := mustCall(t, f.s, f.dir, "active", "append", appendArgs{operation: workflowOp(), Nodes: []NodeInput{
		{Type: "video", Content: json.RawMessage(`{"mode":"t2v","prompt":"Evening light in the courtyard."}`)},
	}}).(appendResult).IDs[0]
	f.activate("active", workflowDeployment)
	run := f.start("active", workflowDeployment, "")
	mustCall(t, f.s, f.dir, "active", "permission", map[string]any{"operationId": uuid.NewString(), "enabled": true})
	f.check("active", "agent", "submit", map[string]any{"operationId": uuid.NewString(), "nodeId": node}, http.StatusForbidden)
	f.call("active", "workflow", "workflow_save_artifact", workflowSaveArtifactArgs{
		operation: workflowOp(), RunID: run.Session.RunID, Title: "正片草稿", NodeID: node,
	})
	f.finish("active", run.Session.RunID, "")
	deployment := f.confirm("active", f.preview("active"))
	if deployment.TargetStageID != workflowGeneration || len(tasksIn(t, f.s, f.dir, "active")) != 0 {
		t.Fatalf("deployment confirmation submitted a paid task: %+v", deployment)
	}
	kickoff := f.start("active", workflowGeneration, deployment.HandoffID)
	if len(kickoff.GenerationResults) != 0 {
		t.Fatalf("generation kickoff read a nonexistent output: %+v", kickoff.GenerationResults)
	}
	f.finish("active", kickoff.Session.RunID, "")
	f.check("active", "human", "workflow_handoff_preview", workflowPreviewArgs{operation: workflowOp()}, http.StatusConflict)

	submit := func(manual bool) Task {
		if manual {
			mustCall(t, f.s, f.dir, "human", "generateT2V", map[string]any{"operationId": uuid.NewString(), "nodeId": node, "confirmed": true})
		} else {
			mustCall(t, f.s, f.dir, "active", "submit", map[string]any{"operationId": uuid.NewString(), "nodeId": node})
		}
		task := tasksIn(t, f.s, f.dir, "active")[0]
		path := "assets/videos/" + task.ID + ".mp4"
		absolute := filepath.Join(f.dir, filepath.FromSlash(path))
		if err := os.MkdirAll(filepath.Dir(absolute), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(absolute, []byte("local completion fixture"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := p.transition(ctx, task, "polling", "fixture-provider-"+task.ID, ""); err != nil {
			t.Fatal(err)
		}
		running := tasksIn(t, f.s, f.dir, "active")[0]
		if err := p.complete(ctx, running, path, nil); err != nil {
			t.Fatal(err)
		}
		return tasksIn(t, f.s, f.dir, "active")[0]
	}
	automatic := submit(false)
	if got := f.view("active").Stages[workflowStageIndex(workflowGeneration)].Generation; got.State != "waiting" {
		t.Fatalf("ordinary auto-authorized output was accepted: %+v", got)
	}
	manual := submit(true)
	playablePath := filepath.Join(f.dir, filepath.FromSlash(manual.OutputPath))
	review := f.preview("active")
	if len(review.Artifacts) != 1 || review.Artifacts[0].NodeID != manual.ResultNodeID || review.Artifacts[0].NodeID == automatic.ResultNodeID {
		t.Fatalf("preview did not snapshot the independently authorized video: %+v", review)
	}
	ref := review.Artifacts[0].workflowArtifactRef
	if item := f.call("active", "human", "workflow_artifact_get", ref).(workflowArtifact); item.HandedOff || item.NodeID != manual.ResultNodeID {
		t.Fatalf("owner could not view generated preview before confirmation: %+v", item)
	}
	f.check("human", "human", "workflow_artifact_get", ref, http.StatusNotFound)
	if err := os.Remove(playablePath); err != nil {
		t.Fatal(err)
	}
	f.check("active", "human", "workflow_handoff_confirm", workflowConfirmArgs{
		operation: workflowOp(), HandoffID: review.HandoffID}, http.StatusConflict)
	if err := os.WriteFile(playablePath, []byte("local completion fixture"), 0o600); err != nil {
		t.Fatal(err)
	}
	generated := f.confirm("active", review)
	if item := f.call("human", "human", "workflow_artifact_get", ref).(workflowArtifact); !item.HandedOff || item.NodeID != manual.ResultNodeID {
		t.Fatalf("formal generated video not shared: %+v", item)
	}
	final := f.start("active", "final-review", generated.HandoffID)
	if len(final.Inputs) != workflowStageIndex("final-review") ||
		final.Inputs[len(final.Inputs)-1].Artifacts[0].NodeID != manual.ResultNodeID {
		t.Fatalf("final review lost verified output: %+v", final.Inputs)
	}
	f.draft("active", final.Session.RunID, "接受成片", workflowArtifact{})
	f.finish("active", final.Session.RunID, "")
	finalPreview := f.preview("active")
	if len(finalPreview.Artifacts) != 2 || finalPreview.Artifacts[1].NodeID != manual.ResultNodeID {
		t.Fatalf("final preview failed to include the exact approved video: %+v", finalPreview.Artifacts)
	}
	if err := os.Remove(playablePath); err != nil {
		t.Fatal(err)
	}
	f.check("active", "human", "workflow_handoff_confirm", workflowConfirmArgs{
		operation: workflowOp(), HandoffID: finalPreview.HandoffID}, http.StatusConflict)
	if err := os.WriteFile(playablePath, []byte("local completion fixture"), 0o600); err != nil {
		t.Fatal(err)
	}
	beforeFinal := f.view("active").Session
	accepted := f.confirm("active", finalPreview)
	if session := f.view("active").Session; accepted.TargetStageID != "" || session.PendingHandoffID != "" ||
		session.ActiveStageID != "final-review" || session.Status != "active" ||
		session.Activation != beforeFinal.Activation || session.SnapshotID != beforeFinal.SnapshotID {
		t.Fatalf("end of chain scheduled a nonexistent stage: %+v / %+v", accepted, session)
	}
}
