package ai

import (
	"context"
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
