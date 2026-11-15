package studio

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
)

func TestWorkflowReviewPreservesVersionsAndCanvas(t *testing.T) {
	dir, other := t.TempDir(), t.TempDir()
	s := New(nil)
	defer func() { _ = s.Close() }()
	for _, session := range []string{"agent", "reviewer"} {
		bindSession(t, s, dir, session)
	}
	call := func(session, action string, data any) any {
		t.Helper()
		return callWorkflow(t, s, dir, session, action, data)
	}
	const aStage, bStage, cStage = "content-analysis", "shooting-script", "storyboard"
	checkWorkflowError(t, s, dir, "reviewer", "human", "workflow_save", map[string]any{}, http.StatusBadRequest)
	saved := call("reviewer", "workflow_get", nil).(workflowView)
	if saved.Revision != 1 || saved.ID != "drama-production" || saved.Name != "AI 短剧制作" || len(saved.Stages) != 7 {
		t.Fatalf("fixed definition: %+v", saved)
	}
	for i, stage := range saved.Stages {
		if stage.workflowStage != dramaWorkflowStages[i] || stage.Status != workflowNotStarted {
			t.Fatalf("stage %d = %+v", i, stage)
		}
	}
	if isolated := callWorkflow(t, s, other, "reviewer", "workflow_get", nil).(workflowView); isolated.ID != saved.ID || len(isolated.Stages) != 7 {
		t.Fatalf("fresh workspace could not read fixed stage list: %+v", isolated)
	}
	if _, err := os.Stat(filepath.Join(other, ".drama-studio")); !os.IsNotExist(err) {
		t.Fatalf("read-only workflow_get created a DB: %v", err)
	}
	checkWorkflowError(t, s, other, "reviewer", "workflow", "workflow_reserve",
		workflowReserveArgs{operation: operation{ID: "unbound"}, StageID: aStage, Revision: saved.Revision}, http.StatusForbidden)
	checkWorkflowError(t, s, dir, "agent", "workflow", "workflow_reserve",
		workflowReserveArgs{operation: operation{ID: "too-soon"}, StageID: bStage, Revision: saved.Revision}, http.StatusConflict)

	start := func(id, priorApproval, expectedRun string) workflowReservation {
		return call("agent", "workflow_reserve", workflowReserveArgs{operation: operation{ID: uuid.NewString()}, StageID: id,
			Revision: saved.Revision, PreviousApproval: priorApproval, ExpectedRunID: expectedRun}).(workflowReservation)
	}
	finishNote := func(session string, reserved workflowReservation, content string) string {
		call(session, "workflow_running", workflowRunningPayload(reserved.RunID))
		nodeID := mustCall(t, s, dir, session, "append", appendArgs{operation: operation{ID: uuid.NewString()},
			Nodes: []NodeInput{{Type: "note", Content: json.RawMessage(content)}}}).(appendResult).IDs[0]
		call(session, "workflow_finish", workflowFinishArgs{RunID: reserved.RunID, NodeIDs: []string{nodeID}})
		return nodeID
	}
	review := func(stage, run, node string, revision int64) workflowView {
		return call("reviewer", "workflow_approve", workflowApproveArgs{workflowDecisionArgs: workflowDecisionArgs{
			operation: operation{ID: uuid.NewString()}, StageID: stage, RunID: run}, Outputs: []workflowRef{{node, revision}}}).(workflowView)
	}

	a := start(aStage, "", "")
	if stage := call("reviewer", "workflow_get", nil).(workflowView).Stages[0]; !stage.Pending || stage.Status != workflowNotStarted {
		t.Fatalf("reservation reported as executing: %+v", stage)
	}
	aID := finishNote("agent", a, `{"text":"# 分析 V1"}`)
	if stage := call("reviewer", "workflow_get", nil).(workflowView).Stages[0]; stage.Status != workflowReview || stage.ApprovalID != "" {
		t.Fatalf("Agent finish approved an unreviewed artifact: %+v", stage)
	}
	approved := review(aStage, a.RunID, aID, 1).Stages[0]
	if approved.Status != workflowApproved || approved.ApprovalID == "" {
		t.Fatalf("review failed: %+v", approved)
	}
	b := call("reviewer", "workflow_reserve", workflowReserveArgs{operation: operation{ID: uuid.NewString()}, StageID: bStage,
		Revision: saved.Revision, PreviousApproval: approved.ApprovalID}).(workflowReservation)
	if !slices.Equal(b.Inputs, []workflowRef{{aID, 1}}) {
		t.Fatalf("next stage input = %+v", b.Inputs)
	}
	bID := finishNote("reviewer", b, `{"text":"脚本 V1"}`)
	bApproved := review(bStage, b.RunID, bID, 1).Stages[1]
	if bApproved.Status != workflowApproved || bApproved.ApprovalID == "" || bApproved.SessionID != "reviewer" {
		t.Fatalf("script stage did not record reviewed output: %+v", bApproved)
	}
	c := start(cStage, bApproved.ApprovalID, "")
	cID := finishNote("agent", c, `{"text":"分镜 V1"}`)
	review(cStage, c.RunID, cID, 1)
	if visible := call("unbound-viewer", "workflow_get", nil).(workflowView).Stages[0]; visible.RunID != a.RunID || visible.SessionID != "agent" || len(visible.Approvals) != 1 || visible.Approvals[0].SessionID != "reviewer" {
		t.Fatalf("unbound Session did not get the workspace progress and audit record: %+v", visible)
	}
	if isolated := callWorkflow(t, s, other, "reviewer", "workflow_get", nil).(workflowView).Stages[0]; isolated.RunID != "" || isolated.Status != workflowNotStarted {
		t.Fatalf("workflow run leaked into another Workspace: %+v", isolated)
	}

	s.SetHumanWriteCheck(func(context.Context, string, string, []string) (bool, error) { return true, nil })
	mustEdit(t, s, dir, "reviewer", "update_node", updateNodeArgs{
		nodeRevisionArgs: nodeRevisionArgs{operation: operation{ID: "edit-a"}, ID: aID, Revision: 1},
		Content:          json.RawMessage(`{"text":"# 分析 V2"}`),
	})
	changed := call("reviewer", "workflow_get", nil).(workflowView)
	if !changed.Stages[0].NeedsReview || changed.Stages[1].Status != workflowStale || changed.Stages[2].Status != workflowStale {
		t.Fatalf("version change did not invalidate visible dependent progress immediately: %+v", changed)
	}
	checkWorkflowError(t, s, dir, "agent", "workflow", "workflow_reserve", workflowReserveArgs{operation: operation{ID: "transitive-old-input"},
		StageID: cStage, Revision: saved.Revision, PreviousApproval: bApproved.ApprovalID, ExpectedRunID: c.RunID}, http.StatusConflict)
	call("reviewer", "workflow_return", workflowDecisionArgs{operation: operation{ID: "reopen-a"}, StageID: aStage, RunID: a.RunID})
	checkWorkflowError(t, s, dir, "reviewer", "human", "workflow_approve", workflowApproveArgs{
		workflowDecisionArgs: workflowDecisionArgs{operation: operation{ID: "wrong-version"}, StageID: aStage, RunID: a.RunID},
		Outputs:              []workflowRef{{aID, 1}},
	}, http.StatusConflict)
	updated := review(aStage, a.RunID, aID, 2)
	if updated.Stages[0].ApprovalID == approved.ApprovalID || updated.Stages[1].Status != workflowStale || updated.Stages[2].Status != workflowStale {
		t.Fatalf("review of updated upstream failed to invalidate all descendants: %+v", updated)
	}
	checkWorkflowError(t, s, dir, "agent", "workflow", "workflow_reserve", workflowReserveArgs{operation: operation{ID: "old-approval"},
		StageID: bStage, Revision: saved.Revision, PreviousApproval: approved.ApprovalID, ExpectedRunID: b.RunID}, http.StatusConflict)
	b2 := start(bStage, updated.Stages[0].ApprovalID, b.RunID)
	if !slices.Equal(b2.Inputs, []workflowRef{{aID, 2}}) {
		t.Fatalf("rerun did not use the newly approved input: %+v", b2)
	}
	b2ID := finishNote("agent", b2, `{"text":"脚本 V2"}`)
	if exactNode(t, s, dir, "reviewer", bID).Deleted || exactNode(t, s, dir, "reviewer", cID).Deleted || bID == b2ID {
		t.Fatal("rerun removed or overwrote pre-existing Canvas output")
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s = New(nil)
	reloaded := call("reviewer", "workflow_get", nil).(workflowView)
	if reloaded.ID != saved.ID || reloaded.Stages[1].RunID != b2.RunID || reloaded.Stages[2].Status != workflowStale {
		t.Fatalf("restart lost workflow state: %+v", reloaded)
	}
	b2Approved := review(bStage, b2.RunID, b2ID, 1).Stages[1]
	c2 := start(cStage, b2Approved.ApprovalID, c.RunID)
	c2ID := finishNote("agent", c2, `{"text":"分镜 V2"}`)
	review(cStage, c2.RunID, c2ID, 1)
	a3 := start(aStage, "", a.RunID)
	call("agent", "workflow_finish", workflowFinishArgs{RunID: a3.RunID, Error: "restarted upstream failed"})
	stale := call("reviewer", "workflow_get", nil).(workflowView)
	if stale.Stages[0].Status != workflowFailed || stale.Stages[1].Status != workflowStale || stale.Stages[2].Status != workflowStale ||
		stale.Stages[1].RunID != b2.RunID || stale.Stages[2].RunID != c2.RunID {
		t.Fatalf("restarted upstream did not stale all dependent approved attempts: %+v", stale)
	}
}

func TestWorkflowExecutionOwnershipReplayAndRecovery(t *testing.T) {
	dir := t.TempDir()
	s := New(nil)
	defer func() { _ = s.Close() }()
	bindSession(t, s, dir, "a")
	bindSession(t, s, dir, "b")
	checkWorkflowError(t, s, dir, "a", "human", "workflow_reserve",
		workflowReserveArgs{operation: operation{ID: "untrusted"}, StageID: "content-analysis", Revision: 1}, http.StatusForbidden)
	oldNode := mustCall(t, s, dir, "a", "append", appendArgs{operation: operation{ID: "historical"},
		Nodes: []NodeInput{{Type: "note", Content: json.RawMessage(`{"text":"existing"}`)}}}).(appendResult).IDs[0]
	args := workflowReserveArgs{operation: operation{ID: "start"}, StageID: "content-analysis", Revision: 1}
	var wg sync.WaitGroup
	results := make(chan workflowReservation, 2)
	for range 2 {
		wg.Go(func() {
			value, err := editCall(s, dir, "a", "workflow", "workflow_reserve", args)
			if err != nil {
				t.Error(err)
				return
			}
			results <- value.(workflowReservation)
		})
	}
	wg.Wait()
	close(results)
	var runID string
	var launches int
	for value := range results {
		if runID != "" && runID != value.RunID {
			t.Fatalf("duplicate operation produced inconsistent reservations: %q and %q", runID, value.RunID)
		}
		runID = value.RunID
		if !value.Duplicate {
			launches++
		}
	}
	if runID == "" || launches != 1 {
		t.Fatalf("got %d actual reservations for a repeated operation", launches)
	}
	checkWorkflowError(t, s, dir, "b", "workflow", "workflow_finish", workflowFinishArgs{RunID: runID, Error: "wrong owner"}, http.StatusForbidden)
	callWorkflow(t, s, dir, "a", "workflow_running", workflowRunningPayload(runID))
	other := New(nil)
	defer other.Close()
	if live := callWorkflow(t, other, dir, "b", "workflow_get", nil).(workflowView).Stages[0]; live.Status != workflowRunning {
		t.Fatalf("second Host changed a live run: %+v", live)
	}
	callWorkflow(t, s, dir, "a", "workflow_finish", workflowFinishArgs{RunID: runID, NodeIDs: []string{oldNode}})
	if old := callWorkflow(t, s, dir, "a", "workflow_get", nil).(workflowView).Stages[0]; old.Status != workflowFailed || old.Error == "" {
		t.Fatalf("historical Canvas node was accepted as a current result: %+v", old)
	}
	checkWorkflowError(t, s, dir, "a", "workflow", "workflow_reserve", workflowReserveArgs{operation: operation{ID: "stale-start"},
		StageID: "content-analysis", Revision: 1}, http.StatusConflict)
	args.ID, args.ExpectedRunID = "new-start", runID
	rerun := callWorkflow(t, s, dir, "a", "workflow_reserve", args).(workflowReservation)
	callWorkflow(t, s, dir, "a", "workflow_running", workflowRunningPayload(rerun.RunID))
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	if recovered := callWorkflow(t, other, dir, "b", "workflow_get", nil).(workflowView).Stages[0]; recovered.RunID != rerun.RunID ||
		recovered.Status != workflowFailed || !strings.Contains(recovered.Error, "Host") {
		t.Fatalf("lost native executor was not surfaced as an interrupted run: %+v", recovered)
	}
	if replay := callWorkflow(t, other, dir, "a", "workflow_reserve", args).(workflowReservation); !replay.Duplicate || replay.RunID != rerun.RunID {
		t.Fatalf("restart replay could re-dispatch an interrupted agent: %+v", replay)
	}
	args.ID, args.ExpectedRunID = "manual-retry", rerun.RunID
	manual := callWorkflow(t, other, dir, "a", "workflow_reserve", args).(workflowReservation)
	callWorkflow(t, other, dir, "a", "workflow_finish", workflowFinishArgs{RunID: manual.RunID, Error: "Skill 不存在"})
	if failed := callWorkflow(t, other, dir, "b", "workflow_get", nil).(workflowView).Stages[0]; failed.Status != workflowFailed || failed.Error != "Skill 不存在" {
		t.Fatalf("pre-launch failure looked like successful or running work: %+v", failed)
	}
}

func TestWorkflowKeepsPreviousCustomDefinitionAndRuns(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	s := New(nil)
	defer s.Close()
	bindSession(t, s, dir, "agent")
	p, err := s.open(ctx, dir, false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.db.ExecContext(ctx, `CREATE TABLE workflow_definition (singleton INTEGER PRIMARY KEY, id TEXT, revision INTEGER, name TEXT, stages TEXT);
		INSERT INTO workflow_definition VALUES(1,'custom-id',3,'Original configuration','[]');
		INSERT INTO workflow_runs VALUES('old-run','content-analysis','agent','approved','{"stage":{"id":"content-analysis","skill":"old-skill","harness":"old rules"}}');`); err != nil {
		t.Fatal(err)
	}
	view := callWorkflow(t, s, dir, "agent", "workflow_get", nil).(workflowView)
	if view.ID != dramaWorkflowID || view.Stages[0].RunID != "" || view.Stages[0].Status != workflowNotStarted {
		t.Fatalf("custom stage was treated as approved fixed-stage progress: %+v", view)
	}
	callWorkflow(t, s, dir, "agent", "workflow_reserve", workflowReserveArgs{operation: operation{ID: "fixed-start"},
		Revision: dramaWorkflowRev, StageID: "content-analysis"})
	var name, raw string
	if err := p.db.QueryRow(`SELECT name,record FROM workflow_definition CROSS JOIN workflow_runs WHERE workflow_runs.id='old-run'`).Scan(&name, &raw); err != nil {
		t.Fatal(err)
	}
	if name != "Original configuration" || !strings.Contains(raw, "old rules") {
		t.Fatalf("legacy workflow data changed: %q/%q", name, raw)
	}
}

func TestWorkflowKeepsVersionlessFixedProgress(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	s := New(nil)
	defer s.Close()
	status := bindSession(t, s, dir, "agent")
	bindSession(t, s, dir, "reviewer")
	node := mustCall(t, s, dir, "agent", "append", appendArgs{operation: operation{ID: "old-output"}, Nodes: []NodeInput{
		{Type: "note", Content: json.RawMessage(`{"text":"Existing approved analysis"}`)},
	}}).(appendResult).IDs[0]
	legacy := workflowRun{WorkflowID: dramaWorkflowID, Stage: workflowStage{ID: "content-analysis", Name: "内容分析", Skill: "content-analysis"},
		Outputs: []workflowRef{{node, 1}}, Approvals: []workflowApproval{{ID: "legacy-approval", SessionID: "reviewer", Outputs: []workflowRef{{node, 1}}}}}
	encoded, err := json.Marshal(legacy)
	if err != nil {
		t.Fatal(err)
	}
	p, err := s.open(ctx, dir, false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.db.ExecContext(ctx, `INSERT INTO workflow_runs VALUES('legacy-fixed','content-analysis','agent','approved',?)`, string(encoded)); err != nil {
		t.Fatal(err)
	}
	view := callWorkflow(t, s, dir, "reviewer", "workflow_get", nil).(workflowView)
	first := view.Stages[0]
	if first.Status != workflowApproved || first.RunID != "legacy-fixed" || first.SkillID != "content-analysis" || first.Skill != "drama-content-analysis" ||
		first.Harness != "stages/content-analysis/harness.md" || first.DefinitionVersion != 0 || first.SkillSHA256 != "" || first.HarnessSHA256 != "" {
		t.Fatalf("legacy progress, global mapping or unknown provenance misreported: %+v", first)
	}
	second := callWorkflow(t, s, dir, "reviewer", "workflow_reserve", workflowReserveArgs{operation: operation{ID: "next"},
		StageID: "shooting-script", Revision: view.Revision, PreviousApproval: first.ApprovalID}).(workflowReservation)
	if !slices.Equal(second.Inputs, first.Outputs) || second.DefinitionVersion != dramaWorkflowRev || second.CanvasID != status.CanvasID {
		t.Fatalf("next run did not inherit the legacy approved artifact with new provenance: %+v", second)
	}
	var stored string
	if err := p.db.QueryRowContext(ctx, `SELECT record FROM workflow_runs WHERE id='legacy-fixed'`).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored != string(encoded) {
		t.Fatalf("legacy fixed record mutated: %s", stored)
	}
}

func TestWorkflowRunSnapshotsAndWorkspaceConflicts(t *testing.T) {
	dir, otherDir := t.TempDir(), t.TempDir()
	s := New(nil)
	defer func() { _ = s.Close() }()
	status := bindSession(t, s, dir, "writer-a")
	bindSession(t, s, dir, "writer-b")
	otherStatus := bindSession(t, s, otherDir, "other-writer")
	reserve := func(id string) workflowReserveArgs {
		return workflowReserveArgs{operation: operation{ID: id}, StageID: "content-analysis", Revision: dramaWorkflowRev}
	}
	type attempt struct {
		session string
		run     workflowReservation
		err     error
	}
	ready := make(chan struct{})
	results := make(chan attempt, 2)
	for _, session := range []string{"writer-a", "writer-b"} {
		go func() {
			<-ready
			value, err := editCall(s, dir, session, "workflow", "workflow_reserve", reserve(session))
			run, _ := value.(workflowReservation)
			results <- attempt{session: session, run: run, err: err}
		}()
	}
	close(ready)
	winner, loser := <-results, <-results
	if winner.err != nil {
		winner, loser = loser, winner
	}
	conflict, ok := loser.err.(*requestError)
	if winner.err != nil || !ok || conflict.code != http.StatusConflict || !strings.Contains(conflict.Error(), winner.session) ||
		!strings.Contains(conflict.Error(), winner.run.RunID) || !strings.Contains(conflict.Error(), winner.run.Stage.ID) {
		t.Fatalf("simultaneous starts did not expose the elected Workspace run: %+v / %+v", winner, loser)
	}
	if winner.run.CanvasID != status.CanvasID || winner.run.WorkspaceID != status.WorkspaceID || winner.run.DefinitionVersion != dramaWorkflowRev {
		t.Fatalf("reservation omitted authoritative scope: %+v", winner.run)
	}
	versions := workflowRunningPayload(winner.run.RunID)
	checkWorkflowError(t, s, dir, winner.session, "workflow", "workflow_running", map[string]string{"runId": winner.run.RunID}, http.StatusBadRequest)
	callWorkflow(t, s, dir, winner.session, "workflow_running", versions)
	callWorkflow(t, s, dir, winner.session, "workflow_running", versions)
	modified := versions
	modified.SkillSHA256 = strings.Repeat("c", 64)
	checkWorkflowError(t, s, dir, winner.session, "workflow", "workflow_running", modified, http.StatusConflict)
	other := callWorkflow(t, s, otherDir, "other-writer", "workflow_reserve", reserve("other")).(workflowReservation)
	if other.CanvasID != otherStatus.CanvasID || other.CanvasID == winner.run.CanvasID || other.RunID == winner.run.RunID {
		t.Fatalf("separate Workspace could not run the same global stage independently: %+v", other)
	}
	modified.RunID = other.RunID
	callWorkflow(t, s, otherDir, "other-writer", "workflow_running", modified)
	current := callWorkflow(t, s, dir, loser.session, "workflow_get", nil).(workflowView).Stages[0]
	if current.Status != workflowRunning || current.SessionID != winner.session || current.SkillID != winner.run.Stage.Skill ||
		current.workflowFileVersions != versions.workflowFileVersions || current.workflowRunScope != winner.run.workflowRunScope {
		t.Fatalf("peer Session did not see the exact running snapshot: %+v", current)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s = New(nil)
	for _, keep := range []struct {
		directory string
		runID     string
		versions  workflowFileVersions
	}{
		{dir, winner.run.RunID, versions.workflowFileVersions},
		{otherDir, other.RunID, modified.workflowFileVersions},
	} {
		got := callWorkflow(t, s, keep.directory, "resumed-viewer", "workflow_get", nil).(workflowView).Stages[0]
		if got.Status != workflowFailed || got.RunID != keep.runID || got.workflowFileVersions != keep.versions {
			t.Fatalf("restart lost immutable execution provenance: %+v", got)
		}
	}
}

func TestWorkflowVideoUsesOnlyAuthorizedResultsOfApprovedDraftVersions(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	s := New(providerFixture{})
	defer s.Close()
	bindSession(t, s, dir, "agent")
	bindSession(t, s, dir, "reviewer")
	p, err := s.open(ctx, dir, false)
	if err != nil {
		t.Fatal(err)
	}
	call := func(session, action string, data any) any {
		return callWorkflow(t, s, dir, session, action, data)
	}
	var priorApproval string
	reserve := func(stage string) workflowReservation {
		return call("agent", "workflow_reserve", workflowReserveArgs{operation: operation{ID: uuid.NewString()}, StageID: stage,
			Revision: dramaWorkflowRev, PreviousApproval: priorApproval}).(workflowReservation)
	}
	approve := func(run workflowReservation, outputs []workflowRef) workflowView {
		view := call("reviewer", "workflow_approve", workflowApproveArgs{workflowDecisionArgs: workflowDecisionArgs{
			operation: operation{ID: uuid.NewString()}, StageID: run.Stage.ID, RunID: run.RunID}, Outputs: outputs}).(workflowView)
		priorApproval = view.Stages[workflowStageIndex(run.Stage.ID)].ApprovalID
		return view
	}
	appendNodes := func(nodes ...NodeInput) []string {
		return mustCall(t, s, dir, "agent", "append", appendArgs{operation: operation{ID: uuid.NewString()}, Nodes: nodes}).(appendResult).IDs
	}
	finish := func(run workflowReservation, nodes ...string) {
		call("agent", "workflow_running", workflowRunningPayload(run.RunID))
		call("agent", "workflow_finish", workflowFinishArgs{RunID: run.RunID, NodeIDs: nodes})
	}
	for _, stage := range dramaWorkflowStages[:workflowStageIndex(workflowDeployment)] {
		run := reserve(stage.ID)
		id := appendNodes(NodeInput{Type: "note", Content: json.RawMessage(`{"text":"phase output"}`)})[0]
		finish(run, id)
		approve(run, []workflowRef{{id, 1}})
	}
	drafts := reserve(workflowDeployment)
	ids := appendNodes(
		NodeInput{Type: "video", Content: json.RawMessage(`{"mode":"t2v","prompt":"A quiet first shot."}`)},
		NodeInput{Type: "video", Content: json.RawMessage(`{"mode":"t2v","prompt":"A quiet second shot."}`)},
	)
	finish(drafts, ids...)
	manual := func(id string) Task {
		mustCall(t, s, dir, "reviewer", "generateT2V", map[string]any{"operationId": uuid.NewString(), "nodeId": id, "confirmed": true})
		return tasksIn(t, s, dir, "reviewer")[0]
	}
	complete := func(task Task) Task {
		resultPath := "assets/videos/" + task.ID + ".mp4"
		output := filepath.Join(dir, filepath.FromSlash(resultPath))
		if err := os.MkdirAll(filepath.Dir(output), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(output, []byte("local completion fixture"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := p.transition(ctx, task, "polling", "fixture-provider-"+task.ID, ""); err != nil {
			t.Fatal(err)
		}
		active := tasksIn(t, s, dir, "reviewer")[0]
		if active.ID != task.ID || active.Status != "polling" {
			t.Fatalf("expected current queued task to claim: %+v", active)
		}
		if err := p.complete(ctx, active, resultPath, nil); err != nil {
			t.Fatal(err)
		}
		return tasksIn(t, s, dir, "reviewer")[0]
	}
	first := complete(manual(ids[0]))
	oldRevision := complete(manual(ids[1]))
	s.SetHumanWriteCheck(func(context.Context, string, string, []string) (bool, error) { return true, nil })
	mustEdit(t, s, dir, "reviewer", "update_node", updateNodeArgs{
		nodeRevisionArgs: nodeRevisionArgs{operation: operation{ID: "edit-second-draft"}, ID: ids[1], Revision: 1},
		Content:          json.RawMessage(`{"mode":"t2v","prompt":"A revised second shot."}`),
	})
	view := approve(drafts, []workflowRef{{ids[0], 1}, {ids[1], 2}})
	videoIndex := workflowStageIndex(workflowGeneration)
	if state := view.Stages[videoIndex].Generation; state.State != "waiting" || !slices.Equal(state.TaskIDs, []string{first.ID}) {
		t.Fatalf("an unchanged authorized result was not reused, or the old draft revision was adopted: %+v", state)
	}
	checkWorkflowError(t, s, dir, "agent", "workflow", "workflow_reserve", workflowReserveArgs{
		operation: operation{ID: "no-approval"}, Revision: dramaWorkflowRev, StageID: workflowGeneration,
		PreviousApproval: priorApproval,
	}, http.StatusConflict)
	if tasks := tasksIn(t, s, dir, "agent"); len(tasks) != 2 {
		t.Fatalf("workflow start implicitly submitted a paid task: %+v", tasks)
	}
	mustCall(t, s, dir, "agent", "permission", map[string]any{"operationId": "allow-ordinary-auto", "enabled": true})
	mustCall(t, s, dir, "agent", "submit", map[string]any{"operationId": "unrelated-auto", "nodeId": ids[1]})
	automatic := complete(tasksIn(t, s, dir, "reviewer")[0])
	current := func() workflowStageView {
		return call("reviewer", "workflow_get", nil).(workflowView).Stages[videoIndex]
	}
	if state := current().Generation; state.State != "waiting" {
		t.Fatalf("an automatically authorized task made the fixed workflow ready: %+v", state)
	}
	second := manual(ids[1])
	if state := current().Generation; state.State != "processing" || !slices.Equal(state.TaskIDs, []string{first.ID, second.ID}) {
		t.Fatalf("manual task not tracked exclusively: %+v", state)
	}
	second = complete(second)
	if state := current().Generation; state.State != "ready" || !slices.Equal(state.TaskIDs, []string{first.ID, second.ID}) {
		t.Fatalf("approved manual results not ready: %+v", state)
	}
	video := reserve(workflowGeneration)
	expected := []workflowRef{{first.ResultNodeID, 1}, {second.ResultNodeID, 1}}
	if !slices.Equal(video.GenerationResults, expected) || slices.Contains(video.GenerationResults, workflowRef{oldRevision.ResultNodeID, 1}) ||
		slices.Contains(video.GenerationResults, workflowRef{automatic.ResultNodeID, 1}) {
		t.Fatalf("generation reservation used incorrect results: %+v", video)
	}
	finish(video)
	if current := current(); current.Status != workflowReview || !slices.Equal(current.Outputs, expected) {
		t.Fatalf("native generation phase did not carry actual Canvas results to human review: %+v", current)
	}
	file := filepath.Join(dir, filepath.FromSlash(second.OutputPath))
	if err := os.Remove(file); err != nil {
		t.Fatal(err)
	}
	if stage := current(); stage.Generation.State != "failed" || !stage.NeedsRerun {
		t.Fatalf("missing local result still marked ready for approval: %+v", stage)
	}
	checkWorkflowError(t, s, dir, "reviewer", "human", "workflow_approve", workflowApproveArgs{workflowDecisionArgs: workflowDecisionArgs{
		operation: operation{ID: "missing-result-review"}, StageID: video.Stage.ID, RunID: video.RunID}, Outputs: expected}, http.StatusConflict)
	if err := os.WriteFile(file, []byte("local completion fixture"), 0o600); err != nil {
		t.Fatal(err)
	}
	updatedContent, err := json.Marshal(map[string]string{"path": second.OutputPath, "providerTaskId": second.ProviderTaskID, "title": "更新标题"})
	if err != nil {
		t.Fatal(err)
	}
	edit := mustEdit(t, s, dir, "reviewer", "update_node", updateNodeArgs{
		nodeRevisionArgs: nodeRevisionArgs{operation: operation{ID: "edit-result-revision"}, ID: second.ResultNodeID, Revision: 1}, Content: updatedContent,
	})
	latest := []workflowRef{expected[0], {second.ResultNodeID, edit.Revision}}
	checkWorkflowError(t, s, dir, "reviewer", "human", "workflow_approve", workflowApproveArgs{workflowDecisionArgs: workflowDecisionArgs{
		operation: operation{ID: "approve-different-revision"}, StageID: video.Stage.ID, RunID: video.RunID}, Outputs: latest}, http.StatusConflict)
	runID := video.RunID
	video = call("agent", "workflow_reserve", workflowReserveArgs{operation: operation{ID: "check-result-revision"}, StageID: workflowGeneration,
		Revision: dramaWorkflowRev, PreviousApproval: priorApproval, ExpectedRunID: runID}).(workflowReservation)
	if !slices.Equal(video.GenerationResults, latest) {
		t.Fatalf("native rerun did not reuse the existing task with the new validated result revision: %+v", video)
	}
	finish(video)
	expected = latest
	approve(video, expected)
	final := reserve("final-review")
	if !slices.Equal(final.Inputs, expected) {
		t.Fatalf("final review did not receive the approved film references: %+v", final)
	}
	id := appendNodes(NodeInput{Type: "note", Content: json.RawMessage(`{"text":"final review notes"}`)})[0]
	finish(final, id)
	if got := approve(final, []workflowRef{{id, 1}}).Stages[6]; got.Status != workflowApproved || got.ApprovalID == "" {
		t.Fatalf("final phase did not persist its approval: %+v", got)
	}
}

func callWorkflow(t *testing.T, s *Service, dir, session, action string, data any) any {
	t.Helper()
	actor := "human"
	if action == "workflow_running" || action == "workflow_finish" || action == "workflow_reserve" {
		actor = "workflow"
	}
	value, err := editCall(s, dir, session, actor, action, data)
	if err != nil {
		t.Fatalf("%s/%s: %v", session, action, err)
	}
	return value
}

func workflowRunningPayload(runID string) workflowRunningArgs {
	return workflowRunningArgs{RunID: runID, workflowFileVersions: workflowFileVersions{
		SkillSHA256: strings.Repeat("a", 64), HarnessSHA256: strings.Repeat("b", 64),
	}}
}

func checkWorkflowError(t *testing.T, s *Service, dir, session, actor, action string, data any, code int) {
	t.Helper()
	if _, err := editCall(s, dir, session, actor, action, data); err == nil {
		t.Fatalf("%s unexpectedly succeeded", action)
	} else if known, ok := err.(*requestError); !ok || known.code != code {
		t.Fatalf("%s rejected with %v, want HTTP %d", action, err, code)
	}
}
