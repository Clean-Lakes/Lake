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

func TestStrategyMaterializationRejectsEditedOrShiftedHistory(t *testing.T) {
	e := &Engine{sessions: map[string]*session{}}
	s := &session{state: State{Config: Config{StrategyLearnEnabled: true, MemoryProjectID: "project"}, View: View{Session: "session", RootTurnID: "turn", TurnStartedAt: timestamp(), TurnFinishedAt: timestamp()}, History: []Message{{HostTurnID: "turn", Role: "user", Content: "以后请先给出证据。"}}, Checkpoints: []int{0}}}
	e.sessions["session"] = s
	input := TurnInput{StrategyMessageID: "actual-message", UserText: "以后请先给出证据。"}
	e.collectStrategySnapshot(s, s.state.Config, input, "completed")
	event := s.state.StrategyOutbox[0]
	if _, eligible, err := e.MaterializeStrategySnapshot(event, "edited message"); err != nil || eligible {
		t.Fatal("edited user source accepted", err)
	}
	s.state.History[0].HostTurnID = "different-turn"
	if _, eligible, err := e.MaterializeStrategySnapshot(event, input.UserText); err != nil || eligible {
		t.Fatal("compacted history replaced trusted turn", err)
	}
}
