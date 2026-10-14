package web

import (
	"context"
	"fmt"
	"github.com/Clean-Lakes/Lake/internal/ai"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func expectTerminalFailure(t *testing.T, fn func()) {
	t.Helper()
	defer func() {
		if recover() == nil {
			t.Error("unapproved terminal access accepted")
		}
	}()
	fn()
}

func TestPermissionToggleDoesNotReviveOldTerminalGrant(t *testing.T) {
	b, h := fixture(t)
	owner, ref := newSession(t, h)
	other := stringOf(b.Store.CreateSession(stringOf(b.Store.Session(owner)["projectId"]), "reader", nil)["id"])
	term := b.Terminals.Open(context.Background(), owner, ref)
	tid := stringOf(term["id"])
	b.adoptTerminal(other, tid, stringOf(term["generation"]))
	b.configure(other, Object{"terminal_id": tid, "asset_ref": ref})
	b.configure(other, Object{"silentCommands": true})
	b.configure(other, Object{"silentCommands": false})
	expectTerminalFailure(t, func() { b.Terminals.Screen(other, tid, "tail", 80, 20000) })
}

func TestFailedBindingValidationRestoresPreviousGrant(t *testing.T) {
	b, h := fixture(t)
	owner, ref := newSession(t, h)
	other := stringOf(b.Store.CreateSession(stringOf(b.Store.Session(owner)["projectId"]), "reader", nil)["id"])
	term := b.Terminals.Open(context.Background(), owner, ref)
	tid := stringOf(term["id"])
	b.Store.SaveOptions(other, Object{"contextWindow": 2047})
	apiTest(t, h, "POST", "/api/sessions/"+other+"/terminals/"+tid+"/adopt", Object{"accept": true, "bind": true, "generation": term["generation"]}, 400)
	expectTerminalFailure(t, func() { b.Terminals.Screen(other, tid, "tail", 80, 20000) })
	b.adoptTerminal(other, tid, stringOf(term["generation"]))
	apiTest(t, h, "POST", "/api/sessions/"+other+"/terminals/"+tid+"/adopt", Object{"accept": true, "bind": true, "generation": term["generation"]}, 400)
	b.Terminals.Screen(other, tid, "tail", 80, 20000)
}

func TestConfigurationRejectsTerminalResourceMismatch(t *testing.T) {
	b, h := fixture(t)
	id, ref := newSession(t, h)
	term := b.Terminals.Open(context.Background(), id, ref)
	alternative := b.Store.CreateResource(stringOf(b.Store.Session(id)["projectId"]), "another host", "local", Object{})
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/configure", Object{"terminal_id": term["id"], "asset_ref": alternative["id"]}, 400)
}

func TestFailedAdoptAndBindDoesNotGrantAccess(t *testing.T) {
	b, h := fixture(t)
	owner, ref := newSession(t, h)
	other := stringOf(b.Store.CreateSession(stringOf(b.Store.Session(owner)["projectId"]), "busy reader", nil)["id"])
	term := b.Terminals.Open(context.Background(), owner, ref)
	tid := stringOf(term["id"])
	started := make(chan struct{}, 1)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"pending\"}}]}\n\n")
		w.(http.Flusher).Flush()
		started <- struct{}{}
		<-r.Context().Done()
	}))
	defer provider.Close()
	b.Models.Save(&ai.Model{URL: provider.URL, Name: "busy binding fixture", Protocol: "openai"})
	b.configure(other, nil)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- b.Engine.Chat(ctx, other, "wait", nil) }()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("model not started")
	}
	apiTest(t, h, "POST", "/api/sessions/"+other+"/terminals/"+tid+"/adopt", Object{"accept": true, "bind": true, "generation": term["generation"]}, 409)
	expectTerminalFailure(t, func() { b.Terminals.Screen(other, tid, "tail", 80, 20000) })
	cancel()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("model did not cancel")
	}
}
func TestAdoptTerminalRequiresGrantAndExclusiveWriter(t *testing.T) {
	b, h := fixture(t)
	owner, ref := newSession(t, h)
	project := stringOf(b.Store.Session(owner)["projectId"])
	other := stringOf(b.Store.CreateSession(project, "adopter", nil)["id"])
	// Start from a locked-down state so the later toggle below is a real
	// permission change regardless of the current defaults.
	b.configure(other, Object{"silentCommands": false})
	term := b.Terminals.Open(context.Background(), owner, ref)
	tid := stringOf(term["id"])
	expectTerminalFailure(t, func() { b.Terminals.Screen(other, tid, "tail", 80, 20000) })
	apiTest(t, h, "POST", "/api/sessions/"+other+"/terminals/"+tid+"/adopt", Object{"accept": true, "generation": "stale"}, 409)
	apiTest(t, h, "POST", "/api/sessions/"+other+"/terminals/"+tid+"/adopt", Object{"accept": true, "generation": term["generation"]}, 200)
	b.Terminals.Screen(other, tid, "tail", 80, 20000)
	expectTerminalFailure(t, func() { b.Terminals.Execute(other, tid, "agent", "pwd", "") })
	b.transferTerminal(other, tid, "agent")
	expectTerminalFailure(t, func() { b.Terminals.Execute(owner, tid, "agent", "pwd", "") })
	entry := b.Terminals.Execute(other, tid, "agent", "pwd", "")
	result := b.Terminals.Wait(context.Background(), other, tid, stringOf(entry["id"]))
	if result["originSessionId"] != other || b.Store.Terminal(owner, tid)["sessionId"] != owner {
		t.Fatal("audit ownership lost", result)
	}
	// State-changing approved actions belong to requester while the terminal stays with its owner.
	action := b.Store.AddAction(other, ref, tid, "printf audit", "fixture", owner)
	b.Store.Decide(stringOf(action["id"]), "approve", "", true)
	entry = b.Terminals.Execute(other, tid, "agent", "printf audit", stringOf(action["id"]))
	b.Terminals.Wait(context.Background(), other, tid, stringOf(entry["id"]))
	if b.Store.Action(stringOf(action["id"]))["status"] != "succeeded" {
		t.Fatal("shared action not completed")
	}
	b.configure(other, Object{"silentCommands": true})
	expectTerminalFailure(t, func() { b.Terminals.Screen(other, tid, "tail", 80, 20000) })
	b.transferTerminal(owner, tid, "user")
	expectTerminalFailure(t, func() { b.Terminals.Screen(other, tid, "tail", 80, 20000) })
	b.adoptTerminal(other, tid, stringOf(term["generation"]))
	b.Terminals.Close(owner, tid)
	expectTerminalFailure(t, func() { b.Terminals.Screen(other, tid, "tail", 80, 20000) })
}
func TestTerminalAdoptionRejectsCrossProjectAndBackgroundBypass(t *testing.T) {
	b, h := fixture(t)
	owner, ref := newSession(t, h)
	term := b.Terminals.Open(context.Background(), owner, ref)
	tid := stringOf(term["id"])
	project := b.Store.CreateProject("other project")
	other := stringOf(b.Store.CreateSession(stringOf(project["id"]), "outsider", nil)["id"])
	expectTerminalFailure(t, func() { b.adoptTerminal(other, tid, stringOf(term["generation"])) })
	for _, name := range []string{"read_terminal_screen", "terminal_expect", "terminal_capabilities", "terminal_wait_command", "terminal_command_status", "terminal_kill_command", "terminal_send_input", "close_ssh_terminal"} {
		if _, err := b.bridge(context.Background(), other, name, Object{"terminal_id": tid, "entry_id": "unknown", "input": "pwd"}, true); err == nil {
			t.Fatal("cross-project bridge bypass", name)
		}
	}
	same := stringOf(b.Store.CreateSession(stringOf(b.Store.Session(owner)["projectId"]), "same project", nil)["id"])
	for _, name := range []string{"terminal_wait_command", "terminal_command_status", "terminal_kill_command"} {
		if _, err := b.bridge(context.Background(), same, name, Object{"terminal_id": tid, "entry_id": "unknown"}, true); err == nil || !strings.Contains(err.Error(), "授权") {
			t.Fatal(name, err)
		}
	}
	otherTerminal := b.Terminals.Open(context.Background(), owner, ref)
	entry := b.Terminals.Execute(owner, stringOf(otherTerminal["id"]), "user", "sleep 0.1", "")
	expectTerminalFailure(t, func() { b.Terminals.Wait(context.Background(), owner, tid, stringOf(entry["id"])) })
	b.Terminals.Wait(context.Background(), owner, stringOf(otherTerminal["id"]), stringOf(entry["id"]))
}

func TestExplicitResourceCloseRevokesAdoptedWriter(t *testing.T) {
	b, h := fixture(t)
	owner, ref := newSession(t, h)
	other := stringOf(b.Store.CreateSession(stringOf(b.Store.Session(owner)["projectId"]), "adopter", nil)["id"])
	term := b.Terminals.Open(context.Background(), owner, ref)
	tid := stringOf(term["id"])
	b.adoptTerminal(other, tid, stringOf(term["generation"]))
	b.transferTerminal(other, tid, "agent")
	apiTest(t, h, "DELETE", "/api/resources/"+ref+"/terminals/"+tid, nil, 200)
	if b.Store.Terminal(owner, tid)["status"] != "disconnected" {
		t.Fatal("explicit user close blocked by adopted writer")
	}
	expectTerminalFailure(t, func() { b.ResolveTerminalAccess(other, tid, false) })
}
