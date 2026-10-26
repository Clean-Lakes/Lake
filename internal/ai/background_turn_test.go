package ai

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestLateBackgroundCompletionUpdatesOnlyOriginalCard(t *testing.T) {
	model, close := fakeModel(t, func(_ int, _ map[string]any) any { return response("new turn reply") })
	defer close()
	e := engineFor(t, model, nil)
	value, err := e.startShell(Config{Runtime: "local"}, map[string]any{"__session": "case"}, "sleep 0.2; printf old-background-result")
	if err != nil {
		t.Fatal(err)
	}
	shell := str(obj(value)["shell_id"])
	first, _ := e.Snapshot("case")
	at := first.Cards[0].At
	if err = e.Abort("case"); err != nil {
		t.Fatal(err)
	}
	if err = e.Chat(context.Background(), "case", "new turn", nil); err != nil {
		t.Fatal(err)
	}
	before, _ := e.Snapshot("case")
	if _, err = e.shellJob(context.Background(), "case", "wait_shell", map[string]any{"shell_id": shell}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	var after View
	for time.Now().Before(deadline) {
		after, _ = e.Snapshot("case")
		if after.Cards[0].Status == "completed" {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if after.Status != before.Status || after.Turns != before.Turns || after.TurnStartedAt != before.TurnStartedAt || after.TurnFinishedAt != before.TurnFinishedAt {
		t.Fatal("old completion modified current turn")
	}
	if after.Cards[0].ID != shell || after.Cards[0].At != at || !strings.Contains(after.Cards[0].Content, "old-background-result") {
		t.Fatal("old completion moved or replaced its card")
	}
}

func TestBackgroundShellCardKeepsOriginalResourceWhenWaitFails(t *testing.T) {
	released := make(chan struct{})
	e, err := New(t.TempDir(), func(ctx context.Context, _ string, name string, _ map[string]any, _ bool) (any, error) {
		if name == "terminal_wait_command" {
			select {
			case <-released:
			case <-ctx.Done():
				return nil, ctx.Err()
			}
			return nil, errors.New("fixture wait failed")
		}
		return map[string]any{"terminal_id": "terminal-b", "entry_id": "entry-b", "status": "running"}, nil
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(e.Shutdown)
	source := map[string]any{"resource_id": "host-b", "target": "主机 B", "parent_card_id": "dispatch-b", "call_id": "call-b", "private_field": "must not copy"}
	ctx := context.WithValue(context.Background(), backgroundShellSourceKey{}, source)
	value, err := e.bridgeCall(ctx, "case", "terminal_execute_command", map[string]any{"run_in_background": true}, true)
	if err != nil {
		close(released)
		t.Fatal(err)
	}
	id := str(obj(value)["shell_id"])
	source["resource_id"] = "later-selected-host"
	first, _ := e.Snapshot("case")
	data := obj(first.Cards[0].Data)
	if first.Cards[0].ID != id || data["resource_id"] != "host-b" || data["parent_card_id"] != "dispatch-b" || data["shell_id"] != id || data["private_field"] != nil {
		close(released)
		t.Fatal("background lost its originating identity", data)
	}
	at := first.Cards[0].At
	close(released)
	if _, err = e.shellJob(context.Background(), "case", "wait_shell", map[string]any{"shell_id": id}); err != nil {
		t.Fatal(err)
	}
	after, _ := e.Snapshot("case")
	if after.Cards[0].Status != "failed" || after.Cards[0].At != at || obj(after.Cards[0].Data)["resource_id"] != "host-b" {
		t.Fatal("failed wait moved or unscoped the background card", after.Cards[0])
	}
}
