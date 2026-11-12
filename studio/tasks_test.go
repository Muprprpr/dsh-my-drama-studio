package studio

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestSessionPermissionAndSubmissionGate(t *testing.T) {
	dir := t.TempDir()
	s := New(nil)
	t.Cleanup(func() { _ = s.Close() })
	bindSession(t, s, dir, "a")
	bindSession(t, s, dir, "b")
	for _, session := range []string{"a", "b"} {
		if status := mustCall(t, s, dir, session, "context", nil).(Status); status.AutoGenerate {
			t.Fatalf("session %s starts authorized", session)
		}
	}
	for _, session := range []string{"a", "b"} {
		mustCall(t, s, dir, session, "append", appendArgs{operation: operation{ID: "append-" + session}, Nodes: []NodeInput{
			{Type: "video", Content: json.RawMessage(`{"prompt":"演员抬头，停顿半秒。"}`)},
		}})
	}
	result := mustCall(t, s, dir, "b", "query", nil).(queryResult)
	if len(result.Nodes) != 2 {
		t.Fatalf("both sessions must append independently of auto-generation: %+v", result)
	}
	id := result.Nodes[0].ID
	permission := map[string]any{"operationId": "allow-b", "enabled": true}
	mustCall(t, s, dir, "b", "permission", permission)
	if status := mustCall(t, s, dir, "b", "context", nil).(Status); !status.AutoGenerate {
		t.Fatal("session b did not acquire permission")
	}
	args := submitArgs{operation: operation{ID: "submit-video"}, NodeID: id}
	if _, err := call(s, dir, "a", "submit", args); err != automaticDisabled {
		t.Fatalf("session a must be denied before provider check: %v", err)
	}
	if _, err := call(s, dir, "b", "submit", args); err != providerUnavailable {
		t.Fatalf("session b did not reach provider gate: %v", err)
	}
	manual := map[string]any{"operationId": "manual", "nodeId": id, "confirmed": true}
	if _, err := call(s, dir, "a", "submit_manual", manual); err != providerUnavailable {
		t.Fatalf("manual submission must bypass automatic generation gate: %v", err)
	}
	manual["confirmed"] = false
	if _, err := call(s, dir, "a", "submit_manual", manual); err == nil || !strings.Contains(err.Error(), "明确确认") {
		t.Fatalf("manual request without confirmation: %v", err)
	}
	for _, field := range []string{"sessionId", "workspacePath", "canvasId", "confirmed"} {
		forged := map[string]any{"operationId": "forged", "nodeId": id, field: "fake"}
		if _, err := call(s, dir, "b", "submit", forged); err == nil || !strings.Contains(err.Error(), "unknown field") {
			t.Fatalf("forged %s accepted: %v", field, err)
		}
	}
	if _, err := call(s, dir, "c", "tasks", nil); err != notBound {
		t.Fatalf("unbound task read: %v", err)
	}
	mustCall(t, s, dir, "b", "permission", map[string]any{"operationId": "deny-b", "enabled": false})
	if _, err := call(s, dir, "b", "submit", args); err != automaticDisabled {
		t.Fatalf("revocation did not deny new submits: %v", err)
	}
	mustCall(t, s, dir, "b", "permission", map[string]any{"operationId": "allow-b-again", "enabled": true})
	mustCall(t, s, dir, "b", "disconnect", operation{ID: "disconnect-b"})
	if status := bindSession(t, s, dir, "b"); status.AutoGenerate {
		t.Fatal("session retained permission across disconnect")
	}
	mustCall(t, s, dir, "b", "permission", map[string]any{"operationId": "allow-before-restart", "enabled": true})
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s = New(nil)
	mustCall(t, s, dir, "b", "permission", permission)
	if status := mustCall(t, s, dir, "b", "context", nil).(Status); !status.Connected || status.AutoGenerate {
		t.Fatalf("restart should keep binding with authorization off, even after replay: %+v", status)
	}
	if _, err := call(s, dir, "b", "submit", args); err != automaticDisabled {
		t.Fatalf("restart did not revoke authorization: %v", err)
	}
	t.Log("automatic grants isolated, explicit manual confirm bypasses only auto grant, stale grant cannot restore access, unbound and injected identities denied")
}
