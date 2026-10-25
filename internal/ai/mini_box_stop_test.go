package ai

import (
	"context"
	"strings"
	"testing"
)

func TestMiniBoxBackgroundStopKeepsUserIntentAndOtherJobs(t *testing.T) {
	e, err := New(t.TempDir(), func(_ context.Context, _ string, _ string, args map[string]any, _ bool) (any, error) {
		if args["terminal_id"] == "stopped-terminal" {
			return map[string]any{"status": "unknown", "exitCode": nil, "stopRequestedAt": "2026-10-24T01:00:00Z", "userStopped": true, "notice": "User stopped this command; do not retry; other resources continue.", "output": "retained partial output"}, nil
		}
		return map[string]any{"status": "completed", "exitCode": 0, "output": "peer completed"}, nil
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(e.Shutdown)
	stopped, err := e.trackBridgeShell("case", map[string]any{"terminal_id": "stopped-terminal", "entry_id": "stopped-entry"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	peer, err := e.trackBridgeShell("case", map[string]any{"terminal_id": "peer-terminal", "entry_id": "peer-entry"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	value, err := e.shellJob(context.Background(), "case", "wait_shell", map[string]any{"shell_id": obj(stopped)["shell_id"]})
	if err != nil || obj(value)["status"] != "interrupted" || obj(value)["userStopped"] != true || !strings.Contains(str(obj(value)["notice"]), "do not retry") {
		t.Fatal("background stop lost user intent", value, err)
	}
	value, err = e.shellJob(context.Background(), "case", "wait_shell", map[string]any{"shell_id": obj(peer)["shell_id"]})
	if err != nil || obj(value)["status"] != "completed" || !strings.Contains(js(value), "peer completed") {
		t.Fatal("peer affected by stop", value, err)
	}
	view, err := e.Snapshot("case")
	if err != nil {
		t.Fatal(err)
	}
	for _, card := range view.Cards {
		if card.ID == obj(stopped)["shell_id"] && (card.Status != "interrupted" || !strings.Contains(card.Content, "userStopped")) {
			t.Fatal("stop card discarded original cause", card)
		}
	}
}
