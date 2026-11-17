package studio

import (
	"context"
	"encoding/json"
	"net/http"
	"slices"
	"testing"
)

func TestWorkflowProfilesStartAtTheirOwnFirstStageAndKeepExplicitHandoffs(t *testing.T) {
	cases := map[string][]string{
		"short-video": {"topic-selection", "content-analysis", "shooting-script", "storyboard", "asset-binding", "video-deployment", "video-generation", "final-review"},
		"short-drama": {"shooting-script", "storyboard", "asset-binding", "video-deployment", "video-generation", "final-review"},
	}
	for id, order := range cases {
		t.Run(id, func(t *testing.T) {
			f := newWorkflowTest(t, nil)
			first, next := order[0], order[1]
			expected := int64(0)
			f.check("a", "human", "workflow_activate", workflowActivateArgs{
				operation: workflowOp(), StageID: first, ExpectedActivation: &expected,
				Snapshot: profileTestSnapshot(workflowProfiles[id], first, "V1"),
			}, http.StatusConflict)
			f.check("a", "human", "workflow_profile_select", workflowProfileArgs{
				operation: workflowOp(), WorkflowProfileID: legacyWorkflowProfileID,
			}, http.StatusBadRequest)
			selection := workflowProfileArgs{operation: workflowOp(), WorkflowProfileID: id}
			f.check("a", "workflow", "workflow_profile_select", selection, http.StatusForbidden)
			selected := f.call("a", "human", "workflow_profile_select", selection).(workflowView)
			gotOrder := make([]string, 0, len(selected.Stages))
			for _, stage := range selected.Stages {
				gotOrder = append(gotOrder, stage.ID)
			}
			if selected.ProfileSelectionRequired || selected.WorkflowDefinitionVersion != 1 || selected.WorkflowProfileID != id || !slices.Equal(order, gotOrder) {
				t.Fatalf("selected wrong profile or stage order: %+v", selected)
			}
			for other := range cases {
				if other != id {
					f.check("b", "human", "workflow_profile_select", workflowProfileArgs{
						operation: workflowOp(), WorkflowProfileID: other,
					}, http.StatusConflict)
				}
			}
			f.check("a", "human", "workflow_activate", f.activation("a", next, "V1"), http.StatusConflict)
			inconsistent := f.activation("a", first, "V1")
			inconsistent.Snapshot.WorkflowDefinitionVersion++
			f.check("a", "human", "workflow_activate", inconsistent, http.StatusBadRequest)
			f.activate("a", first)
			turn := f.start("a", first, "")
			if turn.WorkflowProfileID != id || len(turn.Inputs) != 0 {
				t.Fatalf("first stage used wrong profile or inputs: %+v", turn)
			}
			f.draft("a", turn.Session.RunID, "阶段产物", workflowArtifact{})
			f.finish("a", turn.Session.RunID, "")
			draft := f.preview("a")
			if draft.TargetStageID != next || f.view("a").Session.ActiveStageID != first {
				t.Fatalf("preview changed the active stage or selected the wrong next stage: %+v", draft)
			}
			f.check("b", "human", "workflow_activate", f.activation("b", next, "V1"), http.StatusConflict)
			confirmed := f.confirm("a", draft)
			ordinary := f.call("b", "workflow", "workflow_session", nil).(workflowSessionResult)
			if ordinary.WorkflowProfileID != id || ordinary.Session.Status != "normal" || ordinary.Snapshot != nil || ordinary.Stage != nil {
				t.Fatalf("ordinary chat adopted a stage from another Session: %+v", ordinary)
			}
			f.reopen(nil)
			restored := f.view("a")
			if restored.WorkflowProfileID != id || restored.Session.ActiveStageID != next ||
				restored.ActiveSkillID != selected.Stages[1].Skill || len(restored.Inputs) != 1 ||
				restored.Inputs[0].HandoffID != confirmed.HandoffID {
				t.Fatalf("restart lost profile or handoff: %+v", restored)
			}
			f.activate("b", next)
		})
	}
}

func TestWorkflowProfileMigrationKeepsOriginalSnapshotHash(t *testing.T) {
	ctx := context.Background()
	f := newWorkflowTest(t, nil)
	f.seedLegacyBefore("storyboard")
	activation := f.activation("legacy", "storyboard", "V1")
	activation.Snapshot.SkillID = "custom-storyboard"
	activation.Snapshot.SkillPath = "skills/custom-storyboard/SKILL.md"
	f.call("legacy", "human", "workflow_activate", activation)
	p, err := f.s.open(ctx, f.dir, false)
	if err != nil {
		t.Fatal(err)
	}
	// Simulate the record as persisted before Profiles. Keep the real snapshot bodies and hashes.
	activation.Snapshot.SkillID = ""
	activation.Snapshot.WorkflowDefinitionVersion = 0
	activation.Snapshot.WorkflowProfileID = ""
	body, err := json.Marshal(activation.Snapshot)
	if err != nil {
		t.Fatal(err)
	}
	id := workflowDigest(body)
	if _, err := p.db.Exec(`INSERT INTO workflow_capability_snapshots(id,record) VALUES(?,?);
		UPDATE workflow_sessions SET snapshot_id=? WHERE session_id='legacy';
		DELETE FROM workflow_migrations WHERE name='workspace-profiles-v1';
		DROP TABLE workflow_profile;`, id, string(body), id); err != nil {
		t.Fatal(err)
	}
	f.reopen(nil)
	active := f.call("legacy", "workflow", "workflow_session", nil).(workflowSessionResult)
	if active.WorkflowProfileID != legacyWorkflowProfileID || active.Snapshot == nil || active.Snapshot.SkillID != "custom-storyboard" ||
		active.Snapshot.WorkflowProfileID != legacyWorkflowProfileID || active.Snapshot.WorkflowDefinitionVersion != 1 || active.Session.SnapshotID != id ||
		active.Snapshot.workflowFileVersions != activation.Snapshot.workflowFileVersions {
		t.Fatalf("legacy snapshot not restored under the compatibility profile: %+v", active)
	}
	if view := f.view("legacy"); view.ActiveSkillID != "custom-storyboard" || len(view.Stages) != 7 {
		t.Fatalf("legacy Workflow view lost current Skill or stage order: %+v", view)
	}
	p, err = f.s.open(ctx, f.dir, false)
	if err != nil {
		t.Fatal(err)
	}
	var persisted string
	if err := p.db.QueryRow("SELECT record FROM workflow_capability_snapshots WHERE id=?", id).Scan(&persisted); err != nil || persisted != string(body) {
		t.Fatalf("migration rewrote a hash-pinned record: %v", err)
	}
}

func TestWorkflowProfileDefinitionsRejectInvalidPrerequisites(t *testing.T) {
	for _, requires := range []string{`["later"]`, `["first","first"]`, `["missing"]`, "null"} {
		raw := []byte(`{"id":"test","name":"Test","version":1,"stages":[
			{"id":"first","name":"First","defaultSkill":"drama-first","requires":[]},
			{"id":"second","name":"Second","defaultSkill":"drama-second","requires":` + requires + `},
			{"id":"later","name":"Later","defaultSkill":"drama-later","requires":["second"]}]}`)
		if _, err := decodeWorkflowProfile("test.json", raw); err == nil {
			t.Fatalf("schema accepted invalid prerequisites: %s", requires)
		}
	}
}
