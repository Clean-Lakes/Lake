package ai

import (
	"testing"
)

func TestStrategyHistoryAnchorNeverChangesProviderPayloadOrBudget(t *testing.T) {
	m := Model{URL: "http://127.0.0.1:1/v1", Name: "fixture", Protocol: "openai"}
	original := []Message{{Role: "user", Content: "User request"}}
	anchored := []Message{{HostTurnID: "private-host-anchor", Role: "user", Content: "User request"}}
	_, before, err := modelPayload(m, original, nil)
	if err != nil {
		t.Fatal(err)
	}
	_, after, err := modelPayload(m, anchored, nil)
	if err != nil || js(before) != js(after) || historyCost(original) != historyCost(anchored) {
		t.Fatal("host-only anchor changed provider contract/budget", err)
	}
}

func TestHistoricalStrategyOutboxCanBeAcknowledgedWithoutMaterialization(t *testing.T) {
	e := engineFor(t, Model{URL: "http://127.0.0.1:1", Name: "unused"}, nil)
	s, _ := e.get("case")
	event := SealStrategySnapshot(StrategyTurnSnapshot{Deferred: true, HistoryStart: 0, HistoryEnd: 1, UserTextHash: hash("original"), UserMessageID: "actual", SessionID: "case", ProjectID: "project", TurnID: "turn", Status: "completed"})
	s.state.StrategyOutbox = []StrategyTurnSnapshot{event}
	if !ValidStrategySnapshot(event) {
		t.Fatal("legacy hash changed")
	}
	if err := e.AckStrategyOutbox("case", "turn", "wrong"); err == nil {
		t.Fatal("wrong exact receipt accepted")
	}
	if err := e.AckStrategyOutbox("case", "turn", event.SnapshotHash); err != nil {
		t.Fatal(err)
	}
	if err := e.AckStrategyOutbox("case", "turn", event.SnapshotHash); err != nil {
		t.Fatal("ack not idempotent")
	}
	out, _ := e.StrategyOutbox("case")
	if len(out) != 0 {
		t.Fatal("legacy handoff remained")
	}
}
