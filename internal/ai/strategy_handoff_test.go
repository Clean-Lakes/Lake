package ai

import (
	"encoding/json"
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

// A frozen historical payload catches JSON/tag/order changes that would make
// existing source withdrawal checks reject previously valid snapshots.
func TestHistoricalStrategySnapshotHashAndTamperCompatibility(t *testing.T) {
	const historical = `{"deferred":true,"historyEnd":1,"userTextHash":"original-text-hash","userMessageId":"actual","sessionId":"case","projectId":"project","turnId":"turn","startedAt":"","finishedAt":"","globalEpoch":0,"projectEpoch":0,"status":"completed","profile":"","userText":"","assistantText":"","evidence":null,"correction":false,"modelRef":"","snapshotHash":"ab3783d6a6722d6968a2045bb143a84a75ee1f471b114f23dc88486c18f58a06"}`
	var snapshot StrategyTurnSnapshot
	if err := json.Unmarshal([]byte(historical), &snapshot); err != nil {
		t.Fatal(err)
	}
	if !ValidStrategySnapshot(snapshot) || js(snapshot) != historical {
		t.Fatal("historical snapshot JSON/hash changed")
	}
	snapshot.UserText = "altered historical source"
	if ValidStrategySnapshot(snapshot) {
		t.Fatal("changed historical source accepted")
	}
}
