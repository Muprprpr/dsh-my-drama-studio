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

var testWorkflowVersions = workflowFileVersions{SkillSHA256: strings.Repeat("a", 64), HarnessSHA256: strings.Repeat("b", 64)}

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
	versions := testWorkflowVersions
	if stage == "" {
		versions = workflowFileVersions{}
	}
	return f.call(session, "human", "workflow_activate", workflowActivateArgs{
		operation: workflowOp(), StageID: stage, workflowFileVersions: versions,
	}).(workflowView)
}

func (f *workflowTest) start(session, stage, handoff string) workflowTurnResult {
	f.t.Helper()
	return f.call(session, "workflow", "workflow_turn_start", workflowTurnStartArgs{
		operation: workflowOp(), RunID: uuid.NewString(), StageID: stage, HandoffID: handoff, workflowFileVersions: testWorkflowVersions,
	}).(workflowTurnResult)
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
	}).(workflowHandoff)
}

func (f *workflowTest) reopen(providers providerRegistry) {
	f.t.Helper()
	if err := f.s.Close(); err != nil {
		f.t.Fatal(err)
	}
	f.s = New(providers)
}

func TestWorkflowSessionDraftsAndExplicitHandoff(t *testing.T) {
	f := newWorkflowTest(t, nil)
	const stage = "storyboard"
	const target = "asset-binding"
	idx := workflowStageIndex(stage)
	if v := f.view("normal"); v.Session.Status != "normal" || len(v.Stages) != 7 || v.Stages[idx].Status != workflowNotStarted {
		t.Fatalf("initial workflow: %+v", v)
	}
	if _, err := os.Stat(filepath.Join(f.dir, ".drama-studio")); !os.IsNotExist(err) {
		t.Fatalf("reading normal chat created project state: %v", err)
	}
	if v := f.activate("a", stage); v.Session.Status != "active" || v.Session.ActiveStageID != stage || len(v.Handoffs) != 0 {
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
	f.check("b", "workflow", "workflow_artifact_get", a1.workflowArtifactRef, http.StatusNotFound)
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
	confirm := workflowConfirmArgs{operation: workflowOp(), HandoffID: aPreview.HandoffID}
	a := f.call("a", "human", "workflow_handoff_confirm", confirm).(workflowHandoff)
	var replay workflowHandoff
	replayed := f.call("a", "human", "workflow_handoff_confirm", confirm).(json.RawMessage)
	if err := json.Unmarshal(replayed, &replay); err != nil || a.HandoffID != replay.HandoffID {
		t.Fatalf("confirmation replay: %+v, %v", replay, err)
	}
	f.check("b", "human", "workflow_handoff_confirm", workflowConfirmArgs{
		operation: workflowOp(), HandoffID: bPreview.HandoffID}, http.StatusConflict)
	f.check("a", "human", "workflow_handoff_confirm", workflowConfirmArgs{
		operation: workflowOp(), HandoffID: aPreview.HandoffID}, http.StatusConflict)
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
		v.Session.PendingHandoffID != a.HandoffID || v.Session.Status != "active" {
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
		initial.Session.PendingHandoffID != "" || initial.Session.SkillSHA256 != testWorkflowVersions.SkillSHA256 {
		t.Fatalf("initial turn missed exact approved input: %+v", initial)
	}
	f.draft("a", initial.Session.RunID, "素材说明", workflowArtifact{})
	f.finish("a", initial.Session.RunID, "")
	f.check("a", "workflow", "workflow_turn_start", workflowTurnStartArgs{
		operation: workflowOp(), StageID: target, HandoffID: a.HandoffID, RunID: uuid.NewString(), workflowFileVersions: testWorkflowVersions,
	}, http.StatusConflict)
	binding := f.confirm("a", f.preview("a"))
	b := f.confirm("b", f.preview("b"))
	if b.SourceRevision <= binding.SourceRevision || f.view("normal").Stages[workflowStageIndex(target)].Status != workflowStale {
		t.Fatalf("new upstream version did not invalidate downstream: %+v", f.view("normal"))
	}
}

func TestWorkflowWorkspaceIsolationAndAbandonedTurnRecovery(t *testing.T) {
	f := newWorkflowTest(t, nil)
	other := newWorkflowTest(t, nil)
	f.activate("one", "storyboard")
	other.activate("one", "content-analysis")
	turn := f.start("one", "storyboard", "")
	f.draft("one", turn.Session.RunID, "工作区 A", workflowArtifact{})
	peer := New(nil)
	defer peer.Close()
	value, err := editCall(peer, f.dir, "one", "workflow", "workflow_session", nil)
	if err != nil || value.(workflowSessionResult).Session.Status != workflowRunning {
		t.Fatalf("second kernel marked the live native turn abandoned: %v %v", value, err)
	}
	if v := other.view("one"); v.Session.ActiveStageID != "content-analysis" || len(v.Artifacts) != 0 {
		t.Fatalf("cross-workspace state leak: %+v", v)
	}
	f.reopen(nil)
	if v := f.view("one"); v.Session.Status != workflowFailed || v.Session.ActiveStageID != "storyboard" ||
		len(v.Artifacts) != 1 || len(v.Handoffs) != 0 {
		t.Fatalf("interrupted native run changed active stage, drafts or formal progress: %+v", v)
	}
	resumed := f.start("one", "storyboard", "")
	f.activate("one", "content-analysis")
	f.finish("one", resumed.Session.RunID, "Old turn failed")
	if v := f.view("one"); v.Session.Status != "active" || v.Session.ActiveStageID != "content-analysis" || len(v.Artifacts) != 1 {
		t.Fatalf("old attempt overwrote the new activation: %+v", v)
	}
	if v := f.activate("one", ""); v.Session.Status != "normal" || len(v.Artifacts) != 1 {
		t.Fatalf("exit activated work or removed existing drafts: %+v", v)
	}
}

func TestWorkflowConcurrentConfirmation(t *testing.T) {
	f := newWorkflowTest(t, nil)
	previews := make(map[string]workflowHandoff)
	for _, session := range []string{"a", "b"} {
		f.activate(session, "storyboard")
		run := f.start(session, "storyboard", "")
		f.draft(session, run.Session.RunID, session, workflowArtifact{})
		f.finish(session, run.Session.RunID, "")
		previews[session] = f.preview(session)
	}
	otherKernel := New(nil)
	defer otherKernel.Close()
	ready := make(chan struct{})
	result := make(chan error, 2)
	for session, h := range previews {
		go func(session, id string) {
			<-ready
			kernel := f.s
			if session == "b" {
				kernel = otherKernel
			}
			_, err := editCall(kernel, f.dir, session, "human", "workflow_handoff_confirm", workflowConfirmArgs{
				operation: workflowOp(), HandoffID: id,
			})
			result <- err
		}(session, h.HandoffID)
	}
	close(ready)
	first, second := <-result, <-result
	if first != nil {
		first, second = second, first
	}
	var known *requestError
	if first != nil || !errors.As(second, &known) || known.code != http.StatusConflict || len(f.view("peer").Handoffs) != 1 {
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
	if _, err := p.db.ExecContext(ctx, `DELETE FROM workflow_migrations`); err != nil {
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
	if len(final.Inputs) != 2 || final.Inputs[1].Artifacts[0].NodeID != manual.ResultNodeID {
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
	accepted := f.confirm("active", finalPreview)
	if session := f.view("active").Session; accepted.TargetStageID != "" || session.PendingHandoffID != "" ||
		session.ActiveStageID != "final-review" || session.Status != "active" {
		t.Fatalf("end of chain scheduled a nonexistent stage: %+v / %+v", accepted, session)
	}
}
