package ai

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func routerHistoryMessage(event SuperEvent, body string) Message {
	page := SuperObjectPage{Kind: "task", ID: "historical-task", Revision: 4, Hash: "old-task-hash", Text: strings.Repeat("OLD_HOST_SNAPSHOT ", 2000), NextOffset: 9000}
	envelope := map[string]any{"events": []SuperObjectPage{{Kind: "event", ID: event.ID, Revision: 1, Text: js(event)}}, "tasks": []SuperObjectPage{page}, "notice": routerContextNotice, "futureMetadata": map[string]string{"constraint": "keep this metadata"}}
	return Message{Role: "user", SourceMessageID: event.SourceEventID, HostTurnID: "old-turn", Content: js(envelope) + "\n" + body + "[USER_MESSAGE]\n" + routerUserPreview(event.Payload)}
}

func TestRouterHistoryProjectionPreservesHumanInputsReferencesAndSourceScope(t *testing.T) {
	e, b := superFixture(t)
	event, _, err := e.ReceiveSuperEvent(t.Context(), b, SuperEventInput{SourceEventID: "human", Kind: "message", Payload: "只读核对 node-a，不得重启。"})
	if err != nil {
		t.Fatal(err)
	}
	references := "[ORIGINAL ENTRY TARGET]\n{\"asset_ref\":\"node-a\"}\n[HEXHUB_REFERENCES]\n[{\"kind\":\"role\",\"role_id\":\"stable-role\"}]\n"
	old := routerHistoryMessage(event, references)
	plain := Message{Role: "user", Content: old.Content} // Similar text without host provenance is ordinary prose.
	foreign := old
	foreign.SourceMessageID = "foreign-source"
	changed := old
	changed.Content = strings.ReplaceAll(old.Content, event.Payload, "changed human text")
	noAnchor := old
	noAnchor.HostTurnID = ""
	s, _ := e.get("pilot")
	s.mu.Lock()
	defer s.mu.Unlock()
	s.state.History = []Message{{Role: "system", Content: "No execution authority from history."}, old, {Role: "assistant", Calls: []Call{{ID: "read", Name: "read_super_object", Arguments: `{"id":"historical-task"}`}}}, {Role: "tool", CallID: "read", Name: "read_super_object", Content: "recorded result"}, plain, foreign, changed, noAnchor}
	before := append([]Message(nil), s.state.History...)
	c := Config{SecurityProjectID: b.ProjectID, superRole: "router", superRouter: &superRouterRun{projectID: b.ProjectID}}
	if err = e.projectSuperRouterHistoryLocked(t.Context(), s, c); err != nil {
		t.Fatal(err)
	}
	after := s.state.History
	if len(after) != len(before) || len(after[1].Content) >= len(old.Content)/2 || !strings.Contains(after[1].Content, references+"[USER_MESSAGE]\n"+event.Payload) {
		t.Fatal("projection lost source context or did not remove repeated snapshot")
	}
	first, _, _ := strings.Cut(after[1].Content, "\n")
	var envelope struct {
		Events []SuperObjectPage `json:"events"`
	}
	if json.Unmarshal([]byte(first), &envelope) != nil || len(envelope.Events) != 1 || envelope.Events[0].Text != js(event) || !strings.Contains(after[1].Content, "old-task-hash") || !strings.Contains(after[1].Content, "keep this metadata") {
		t.Fatal("original event and historical identity lost")
	}
	for i := range before {
		if i != 1 && !reflect.DeepEqual(before[i], after[i]) {
			t.Fatalf("unrelated history changed at %d", i)
		}
	}
	once := js(after)
	if err = e.projectSuperRouterHistoryLocked(t.Context(), s, c); err != nil || js(s.state.History) != once {
		t.Fatal("projection is not idempotent", err)
	}
	s.state.History = before
	foreignConfig := c
	foreignConfig.SecurityProjectID = "foreign"
	if err = e.projectSuperRouterHistoryLocked(t.Context(), s, foreignConfig); err != nil || !reflect.DeepEqual(before, s.state.History) {
		t.Fatal("foreign project projected history", err)
	}
	if err = e.projectSuperRouterHistoryLocked(t.Context(), s, Config{SecurityProjectID: b.ProjectID}); err != nil || !reflect.DeepEqual(before, s.state.History) {
		t.Fatal("ordinary session was rewritten", err)
	}
}

func TestRouterHistoryProjectionRunsAfterDurableADKRestoreWithoutSummary(t *testing.T) {
	e, b := superFixture(t)
	event, _, err := e.ReceiveSuperEvent(t.Context(), b, SuperEventInput{SourceEventID: "old-human", ThreadRef: "pilot", Kind: "message", Payload: "只读检查，不得重启。"})
	if err != nil {
		t.Fatal(err)
	}
	var summaries, calls atomic.Int32
	m, closeModel := fakeModel(t, func(_ int, body map[string]any) any {
		if strings.Contains(js(body["messages"]), "handoff summary") {
			summaries.Add(1)
		}
		if strings.Contains(js(body["messages"]), "OLD_HOST_SNAPSHOT") {
			t.Error("obsolete task snapshot reached provider")
		}
		calls.Add(1)
		return response("已记录，只读检查。")
	})
	defer closeModel()
	m.ContextWindow = 128000
	if err = e.Configure("pilot", Config{Model: m, SecurityProjectID: b.ProjectID, Profile: "core"}); err != nil {
		t.Fatal(err)
	}
	if err = e.RunPilotRouter(t.Context(), "pilot", b); err != nil {
		t.Fatal(err)
	}
	s, _ := e.get("pilot")
	s.mu.Lock()
	for i := 0; i < 24; i++ {
		s.state.History = append(s.state.History, routerHistoryMessage(event, ""))
	}
	s.state.View.Cards = append(s.state.View.Cards, Card{ID: "audit", Type: "operation", Status: "completed", Content: "original recorded result", At: timestamp()})
	if err = e.saveNativeMutationLocked(s); err != nil {
		s.mu.Unlock()
		t.Fatal(err)
	}
	runtimeID := s.state.Runtime.SessionID
	s.mu.Unlock()
	reloaded, err := New(e.Dir, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(reloaded.Shutdown)
	if err = reloaded.Configure("pilot", Config{Model: m, SecurityProjectID: b.ProjectID, Profile: "core"}); err != nil {
		t.Fatal(err)
	}
	// An accidental summary now fails quickly instead of making the test wait.
	reloaded.compactionTimeout = time.Millisecond
	if _, _, err = reloaded.ReceiveSuperEvent(context.Background(), b, SuperEventInput{SourceEventID: "new-human", ThreadRef: "pilot", Kind: "message", Payload: "继续，只读核对。"}); err != nil {
		t.Fatal(err)
	}
	if err = reloaded.RunPilotRouter(t.Context(), "pilot", b); err != nil {
		t.Fatal(err)
	}
	h, err := reloaded.History("pilot")
	if err != nil || validHistory(h) != nil || summaries.Load() != 0 || calls.Load() != 2 {
		t.Fatal("restored history still needed a summary", err, summaries.Load(), calls.Load())
	}
	if !strings.Contains(js(h), "不得重启") || strings.Contains(js(h), "OLD_HOST_SNAPSHOT") {
		t.Fatal("human constraints lost or old snapshot retained")
	}
	view, _ := reloaded.Snapshot("pilot")
	found := false
	for _, card := range view.Cards {
		found = found || card.ID == "audit" && card.Content == "original recorded result"
	}
	if !found {
		t.Fatal("audit cards changed")
	}
	store, _ := reloaded.adkStore()
	var count int64
	if err = store.DB.Table("sessions").Where("id = ?", runtimeID).Count(&count).Error; err != nil || count != 1 {
		t.Fatal("original ADK session was removed", err)
	}
}
