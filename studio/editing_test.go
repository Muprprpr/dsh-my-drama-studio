package studio

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
)

func editCall(s *Service, dir, session, actor, action string, data any) (any, error) {
	encoded, err := json.Marshal(data)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	return s.Execute(ctx, Request{
		SessionID: session, WorkspaceID: "native-workspace", WorkspacePath: dir, Actor: actor, Action: action, Data: encoded,
	})
}

func mustEdit(t *testing.T, s *Service, dir, session, action string, data any) editResult {
	t.Helper()
	result, err := editCall(s, dir, session, "human", action, data)
	if err != nil {
		t.Fatalf("%s/%s: %v", session, action, err)
	}
	return result.(editResult)
}

func exactNode(t *testing.T, s *Service, dir, session, id string) Node {
	t.Helper()
	result := mustCall(t, s, dir, session, "query", queryArgs{ID: id}).(queryResult)
	if len(result.Nodes) != 1 {
		t.Fatalf("expected node %q, found %+v", id, result.Nodes)
	}
	return result.Nodes[0]
}

func TestHumanWriteChecksWorkspaceAtCommit(t *testing.T) {
	dir := t.TempDir()
	s := New(nil)
	defer s.Close()
	for _, id := range []string{"a", "b", "disconnected"} {
		bindSession(t, s, dir, id)
	}
	mustCall(t, s, dir, "disconnected", "disconnect", operation{ID: "disconnect"})
	old := NodeInput{ID: uuid.NewString(), Type: "shot", Content: json.RawMessage(`{"description":"old"}`)}
	ref := NodeInput{ID: uuid.NewString(), Type: "note", Content: json.RawMessage(`{"text":"reference"}`)}
	mustCall(t, s, dir, "a", "append", appendArgs{operation: operation{ID: "start"}, Nodes: []NodeInput{old, ref},
		Edges: []Edge{{Source: ref.ID, Target: old.ID}}})
	if current := mustCall(t, s, dir, "b", "connected_sessions", nil).(connectedSessionsResult); !slices.Equal(current.SessionIDs, []string{"a", "b"}) {
		t.Fatalf("bound Sessions: %+v", current)
	}
	args := updateNodeArgs{nodeRevisionArgs: nodeRevisionArgs{operation: operation{ID: "update"}, ID: old.ID, Revision: 1},
		ShotID: "SH01", Content: json.RawMessage(`{"description":"saved"}`)}
	erase := nodeRevisionArgs{operation: operation{ID: "delete"}, ID: old.ID, Revision: 1}
	unlink := changeEdgeArgs{operation: operation{ID: "unlink"}, Source: ref.ID, Target: old.ID, Revision: 1}
	for _, actor := range []string{"", "agent"} {
		for action, data := range map[string]any{"update_node": args, "delete_node": erase, "delete_edge": unlink} {
			if _, err := editCall(s, dir, "a", actor, action, data); err != humanWriteOnly {
				t.Fatalf("%s was allowed for %q: %v", action, actor, err)
			}
		}
	}
	if _, err := editCall(s, dir, "b", "human", "update_node", args); err != activityUnavailable {
		t.Fatalf("missing activity check allowed edit: %v", err)
	}

	var running atomic.Bool
	var hold atomic.Bool
	hold.Store(true)
	entered, resume := make(chan struct{}), make(chan struct{})
	s.SetHumanWriteCheck(func(ctx context.Context, workspaceID, sessionID string, ids []string) (bool, error) {
		if workspaceID != "native-workspace" || sessionID != "b" || !slices.Equal(ids, []string{"a", "b"}) {
			return false, fmt.Errorf("activity check received the wrong identities: %s/%s %v", workspaceID, sessionID, ids)
		}
		if hold.CompareAndSwap(true, false) {
			close(entered)
			select {
			case <-ctx.Done():
				return false, ctx.Err()
			case <-resume:
			}
		}
		return !running.Load(), nil
	})
	result := make(chan error, 1)
	before := mustCall(t, s, dir, "b", "context", nil).(Status)
	go func() {
		_, err := editCall(s, dir, "b", "human", "update_node", args)
		result <- err
	}()
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("queued write never reached final activity check")
	}
	running.Store(true)
	close(resume)
	if err := <-result; err != workspaceBusy {
		t.Fatalf("Agent started during save, got: %v", err)
	}
	for action, data := range map[string]any{"delete_node": erase, "delete_edge": unlink} {
		if _, err := editCall(s, dir, "b", "human", action, data); err != workspaceBusy {
			t.Fatalf("busy %s: %v", action, err)
		}
	}
	rolledBack := mustCall(t, s, dir, "b", "query", nil).(queryResult)
	if rolledBack.Status.EventSeq != before.EventSeq || len(rolledBack.Edges) != 1 {
		t.Fatalf("rejected edit left changes: %+v", rolledBack)
	}
	if node := exactNode(t, s, dir, "b", old.ID); string(node.Content) != string(old.Content) || node.Revision != 1 {
		t.Fatalf("rejected edit changed the node: %+v", node)
	}
	mustCall(t, s, dir, "b", "append", appendArgs{operation: operation{ID: "allowed-while-running"},
		Nodes: []NodeInput{{Type: "note", Content: json.RawMessage(`{"text":"new while busy"}`)}}})
	if _, err := call(s, dir, "a", "append", appendArgs{operation: operation{ID: "replace"}, Nodes: []NodeInput{old}}); err == nil || !strings.Contains(err.Error(), "ID 已存在") {
		t.Fatalf("append reused an existing ID: %v", err)
	}
	running.Store(false)
	saved := mustEdit(t, s, dir, "b", "update_node", args)
	if node := exactNode(t, s, dir, "a", old.ID); node.ID != saved.ID || node.Revision != 2 ||
		node.CreatedBySession != "a" || node.ShotID != "SH01" || string(node.Content) != string(args.Content) {
		t.Fatalf("in-place save lost identity or content: %+v", node)
	}
	if _, err := editCall(s, dir, "b", "human", "delete_node", erase); err != revisionConflict {
		t.Fatalf("stale delete: %v", err)
	}
	if _, err := editCall(s, dir, "b", "human", "update_node", updateNodeArgs{
		nodeRevisionArgs: nodeRevisionArgs{operation: operation{ID: "stale"}, ID: old.ID, Revision: 1}, Content: old.Content,
	}); err != revisionConflict {
		t.Fatalf("stale edit: %v", err)
	}
	erase.Revision = saved.Revision
	deleted := mustEdit(t, s, dir, "b", "delete_node", erase)
	if node := exactNode(t, s, dir, "a", old.ID); !node.Deleted || !deleted.Tombstone || node.Revision != 3 {
		t.Fatalf("deletion lost reserved identity: %+v", node)
	}
	if _, err := call(s, dir, "a", "append", appendArgs{operation: operation{ID: "resurrect"}, Nodes: []NodeInput{old}}); err == nil || !strings.Contains(err.Error(), "ID 已存在") {
		t.Fatalf("append resurrected a deleted ID: %v", err)
	}
}

func TestHumanOrderedEdgesStayConsistent(t *testing.T) {
	dir := t.TempDir()
	s := New(nil)
	defer s.Close()
	bindSession(t, s, dir, "a")
	s.SetHumanWriteCheck(func(context.Context, string, string, []string) (bool, error) { return true, nil })
	first, second, video, shot, note := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	prompt := `{"mode":"i2v","prompt":"延续 @图片1 的动作。","mixedListOrder":[%q]}`
	mustCall(t, s, dir, "a", "append", appendArgs{operation: operation{ID: "nodes"}, Nodes: []NodeInput{
		{ID: first, Type: "image", Content: json.RawMessage(`{"path":"assets/images/one.png"}`)},
		{ID: second, Type: "image", Content: json.RawMessage(`{"path":"assets/images/two.png"}`)},
		{ID: note, Type: "note", Content: json.RawMessage(`{"text":"旁注"}`)},
		{ID: video, Type: "video", Content: json.RawMessage(fmt.Sprintf(prompt, first))},
		{ID: shot, Type: "shot", Content: json.RawMessage(fmt.Sprintf(`{"mixedListOrder":[%q]}`, first))},
	}, Edges: []Edge{{first, video}, {first, shot}, {note, shot}}})
	mustEdit(t, s, dir, "a", "update_edge", changeEdgeArgs{
		operation: operation{ID: "replace"}, Source: first, Target: video, NewSource: second, Revision: 1,
	})
	if result := exactNode(t, s, dir, "a", video); result.Revision != 2 || !strings.Contains(string(result.Content), second) {
		t.Fatalf("edge replacement did not update the ordered slot: %+v", result)
	}
	for _, args := range []changeEdgeArgs{
		{operation: operation{ID: "remove-required"}, Source: second, Target: video, Revision: 2},
		{operation: operation{ID: "replace-with-text"}, Source: second, Target: video, NewSource: note, Revision: 2},
	} {
		action := "update_edge"
		if args.NewSource == "" {
			action = "delete_edge"
		}
		_, err := editCall(s, dir, "a", "human", action, args)
		var bad *requestError
		if !errors.As(err, &bad) || bad.code != http.StatusBadRequest {
			t.Fatalf("invalid video relationship accepted: %v", err)
		}
	}
	if current := exactNode(t, s, dir, "a", video); current.Revision != 2 || !strings.Contains(string(current.Content), second) {
		t.Fatalf("invalid relationship corrupted video: %+v", current)
	}
	none := []string{}
	mustEdit(t, s, dir, "a", "update_node", updateNodeArgs{
		nodeRevisionArgs: nodeRevisionArgs{operation: operation{ID: "switch-mode"}, ID: video, Revision: 2},
		Content:          json.RawMessage(`{"mode":"t2v","prompt":"演员穿过房间。"}`), ReferenceSources: &none,
	})
	mustEdit(t, s, dir, "a", "delete_node", nodeRevisionArgs{operation: operation{ID: "archive-image"}, ID: first, Revision: 1})
	mustEdit(t, s, dir, "a", "update_node", updateNodeArgs{
		nodeRevisionArgs: nodeRevisionArgs{operation: operation{ID: "edit-archived-reference"}, ID: shot, Revision: 1},
		Content:          json.RawMessage(`{"description":"保留原参考"}`), ReferenceSources: &[]string{first},
	})
	if current := exactNode(t, s, dir, "a", first); !current.Deleted || !strings.Contains(string(current.Content), "one.png") {
		t.Fatalf("referenced deletion lost media: %+v", current)
	}
	if _, err := call(s, dir, "a", "append", appendArgs{operation: operation{ID: "new-archived-reference"}, Edges: []Edge{{first, note}}}); err == nil {
		t.Fatal("append connected a new reference to archived media")
	}
	snapshot := mustCall(t, s, dir, "a", "query", nil).(queryResult)
	if len(snapshot.Nodes) != 4 || !slices.Equal(snapshot.Edges, []Edge{{first, shot}, {note, shot}}) {
		t.Fatalf("active query lost a retained source or showed a removed edge: %+v", snapshot)
	}
	mustEdit(t, s, dir, "a", "delete_edge", changeEdgeArgs{
		operation: operation{ID: "remove-editorial-edge"}, Source: note, Target: shot, Revision: 2,
	})
	if snapshot := mustCall(t, s, dir, "a", "query", nil).(queryResult); !slices.Equal(snapshot.Edges, []Edge{{first, shot}}) {
		t.Fatalf("removed editorial edge is still returned: %+v", snapshot.Edges)
	}
}

func TestHumanWriteMigratesExistingCanvas(t *testing.T) {
	dir := t.TempDir()
	s := New(nil)
	initial := bindSession(t, s, dir, "a")
	added := mustCall(t, s, dir, "a", "append", appendArgs{operation: operation{ID: "legacy"}, Nodes: []NodeInput{
		{Type: "note", Content: json.RawMessage(`{"text":"before"}`)},
	}}).(appendResult)
	p, err := s.open(context.Background(), dir, false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.db.Exec(`ALTER TABLE nodes DROP COLUMN revision;
		ALTER TABLE nodes DROP COLUMN deleted;
		CREATE TRIGGER nodes_no_update BEFORE UPDATE ON nodes BEGIN SELECT RAISE(ABORT, 'nodes are append-only'); END;
		CREATE TRIGGER nodes_no_delete BEFORE DELETE ON nodes BEGIN SELECT RAISE(ABORT, 'nodes are append-only'); END;
		CREATE TRIGGER edges_no_update BEFORE UPDATE ON edges BEGIN SELECT RAISE(ABORT, 'edges are append-only'); END;
		CREATE TRIGGER edges_no_delete BEFORE DELETE ON edges BEGIN SELECT RAISE(ABORT, 'edges are append-only'); END;`); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s = New(nil)
	defer s.Close()
	s.SetHumanWriteCheck(func(context.Context, string, string, []string) (bool, error) { return true, nil })
	id := added.IDs[0]
	if current := exactNode(t, s, dir, "a", id); current.Revision != 1 || current.Deleted {
		t.Fatalf("legacy row was not migrated: %+v", current)
	}
	mustEdit(t, s, dir, "a", "update_node", updateNodeArgs{
		nodeRevisionArgs: nodeRevisionArgs{operation: operation{ID: "update-legacy"}, ID: id, Revision: 1},
		Content:          json.RawMessage(`{"text":"after"}`),
	})
	current := mustCall(t, s, dir, "a", "query", queryArgs{ID: id}).(queryResult)
	if current.Status.CanvasID != initial.CanvasID || current.Nodes[0].Revision != 2 {
		t.Fatalf("migration changed Canvas identity or revision: %+v", current)
	}
}
