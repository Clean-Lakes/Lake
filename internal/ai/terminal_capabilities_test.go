package ai

import (
	"context"
	"strings"
	"sync/atomic"
	"testing"
)

func TestDisconnectedTerminalDoesNotAdvertiseOrExecuteCommands(t *testing.T) {
	var executed atomic.Bool
	m, close := fakeModel(t, func(n int, body map[string]any) any {
		for _, tool := range arr(body["tools"]) {
			name := str(obj(obj(tool)["function"])["name"])
			if name == "terminal_execute_command" || name == "terminal_send_input" || name == "terminal_expect" {
				t.Error("disconnected capability advertised", name)
			}
		}
		if n == 1 {
			return response("", Call{ID: "unsupported", Name: "terminal_execute_command", Arguments: `{"command":"pwd"}`})
		}
		messages := arr(body["messages"])
		if !strings.Contains(str(obj(messages[len(messages)-1])["content"]), "unavailable") {
			t.Error("unsupported command not rejected")
		}
		return response("historical only")
	})
	defer close()
	bridge := func(_ context.Context, _ string, name string, _ map[string]any, _ bool) (any, error) {
		if name == "terminal_capabilities" {
			return map[string]any{"status": "disconnected", "commandBlocks": false}, nil
		}
		executed.Store(true)
		return nil, nil
	}
	e := engineFor(t, m, bridge)
	if err := e.Configure("case", Config{Model: m, Profile: "terminal2", Runtime: "local", TerminalID: "terminal"}); err != nil {
		t.Fatal(err)
	}
	if err := e.Chat(context.Background(), "case", "read history", nil); err != nil {
		t.Fatal(err)
	}
	if executed.Load() {
		t.Fatal("unsupported command reached terminal bridge")
	}
}
