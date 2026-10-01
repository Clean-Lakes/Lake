package store

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
)

func TestEmptyAgentEventsSerializeAsArray(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	lake, err := s.CreateLake(ctx, "empty event lake", "")
	if err != nil {
		t.Fatal(err)
	}
	conversation, err := s.CreateConversation(ctx, lake.Name)
	if err != nil {
		t.Fatal(err)
	}
	events, err := s.ListAgentEvents(ctx, conversation.ID, 0, 20)
	if err != nil {
		t.Fatal(err)
	}
	body, err := json.Marshal(events)
	if err != nil || string(body) != "[]" {
		t.Fatalf("empty events JSON = %s, err = %v", body, err)
	}
}

func TestQuestionEventsRejectHiddenFieldsAndSecrets(t *testing.T) {
	for _, questions := range []string{`[{"id":"target","header":"目标","prompt":"选择目标","unknown":"hidden"}]`, `[{"id":"target","header":"目标","prompt":"选择目标"}] true`} {
		body, _ := json.Marshal(map[string]string{"question_id": "q1", "questions_json": questions})
		if _, err := checkedEventPayload("question_asked", body); err == nil {
			t.Fatal("invalid nested question payload accepted")
		}
	}
	body, _ := json.Marshal(map[string]string{"question_id": "q1", "answers_json": `{"target":"API_KEY=fixture"}`})
	if _, err := checkedEventPayload("question_answered", body); err == nil {
		t.Fatal("secret answer persisted")
	}
}

func TestPresentationFailureEventStoresOnlyKnownCategory(t *testing.T) {
	for _, code := range []string{"invalid_ui", "invalid_report", "presentation_unavailable"} {
		payload, _ := json.Marshal(map[string]string{"status": "failed", "error_code": code})
		if _, err := checkedEventPayload("tool_finished", payload); err != nil {
			t.Fatal(err)
		}
	}
	for _, payload := range []string{`{"status":"failed","error_code":"unknown"}`, `{"status":"failed","error_code":"API_KEY=fixture"}`, `{"status":"failed","error_code":null}`, `{"status":"failed","error_code":"invalid_ui","arguments":{}}`} {
		if _, err := checkedEventPayload("tool_finished", json.RawMessage(payload)); err == nil {
			t.Fatal("arbitrary diagnostic data accepted")
		}
	}
}

func TestAppendAgentEventAllocatesUniqueSequenceAndListsByCursor(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	lake, err := s.CreateLake(ctx, "event lake", "")
	if err != nil {
		t.Fatal(err)
	}
	conversation, err := s.CreateConversation(ctx, lake.Name)
	if err != nil {
		t.Fatal(err)
	}
	const count = 12
	var workers sync.WaitGroup
	errors := make(chan error, count)
	for i := 0; i < count; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			_, err := s.AppendAgentEvent(ctx, conversation.ID, AgentEventInput{
				Kind: "tool_finished", Actor: "specialist:ssh", ToolCallID: "call-1",
				Payload: json.RawMessage(`{"status":"completed","preview":"CPU idle"}`),
			})
			errors <- err
		}()
	}
	workers.Wait()
	close(errors)
	for err := range errors {
		if err != nil {
			t.Fatal(err)
		}
	}
	events, err := s.ListAgentEvents(ctx, conversation.ID, 0, 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != count {
		t.Fatalf("events=%d, want %d", len(events), count)
	}
	for i, event := range events {
		if event.Sequence != uint64(i+1) || event.ToolCallID != "call-1" {
			t.Fatalf("event %d = %+v", i, event)
		}
	}
	page, err := s.ListAgentEvents(ctx, conversation.ID, 6, 3)
	if err != nil || len(page) != 3 || page[0].Sequence != 7 || page[2].Sequence != 9 {
		t.Fatalf("cursor page=%+v err=%v", page, err)
	}
}

func TestAppendAgentEventRejectsUnknownFieldsAndOversizedPreview(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	lake, err := s.CreateLake(ctx, "event lake", "")
	if err != nil {
		t.Fatal(err)
	}
	conversation, err := s.CreateConversation(ctx, lake.Name)
	if err != nil {
		t.Fatal(err)
	}
	for _, payload := range []json.RawMessage{
		json.RawMessage(`{"status":"completed","api_key":"secret"}`),
		json.RawMessage(`{"status":"completed","arguments":{"command":"unsafe"}}`),
		json.RawMessage(`{"status":"completed","preview":"` + strings.Repeat("x", 65536) + `"}`),
	} {
		if _, err := s.AppendAgentEvent(ctx, conversation.ID, AgentEventInput{Kind: "tool_finished", Actor: "specialist:ssh", Payload: payload}); err == nil {
			t.Fatal("unsafe payload was accepted")
		}
	}
	var count int
	if err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM conversation_event WHERE conversation_id=?`, conversation.ID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("rejected event persisted: count=%d err=%v", count, err)
	}
}

func TestAppendAgentEventRedactsPrivateKeyPreview(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	lake, err := s.CreateLake(ctx, "event lake", "")
	if err != nil {
		t.Fatal(err)
	}
	conversation, err := s.CreateConversation(ctx, lake.Name)
	if err != nil {
		t.Fatal(err)
	}
	event, err := s.AppendAgentEvent(ctx, conversation.ID, AgentEventInput{
		Kind: "tool_finished", Actor: "specialist:code",
		Payload: json.RawMessage(`{"status":"completed","preview":"-----BEGIN OPENSSH PRIVATE KEY-----"}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(event.Payload), "PRIVATE KEY") || !strings.Contains(string(event.Payload), "[redacted]") {
		t.Fatalf("secret preview was persisted: %s", event.Payload)
	}
}

func TestSaveConversationSummaryKeepsSourceSequence(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	lake, err := s.CreateLake(ctx, "event lake", "")
	if err != nil {
		t.Fatal(err)
	}
	conversation, err := s.CreateConversation(ctx, lake.Name)
	if err != nil {
		t.Fatal(err)
	}
	for _, preview := range []string{"first", "second"} {
		body, _ := json.Marshal(map[string]string{"preview": preview})
		if _, err := s.AppendAgentEvent(ctx, conversation.ID, AgentEventInput{Kind: "user", Actor: "user", Payload: body}); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.SaveConversationSummary(ctx, conversation.ID, ConversationSummaryInput{
		ThroughSeq: 2, Text: "The user asked twice.", SourceEventIDs: []uint64{1, 2}, TokenEstimate: 12,
	}); err != nil {
		t.Fatal(err)
	}
	var text, sourceJSON string
	if err := s.db.QueryRowContext(ctx, `SELECT text,source_event_ids FROM conversation_summary WHERE conversation_id=? AND through_seq=2`, conversation.ID).Scan(&text, &sourceJSON); err != nil {
		t.Fatal(err)
	}
	if text != "The user asked twice." || sourceJSON != "[1,2]" {
		t.Fatalf("summary text=%q sources=%q", text, sourceJSON)
	}
	if err := s.SaveConversationSummary(ctx, conversation.ID, ConversationSummaryInput{ThroughSeq: 3, Text: "future", SourceEventIDs: []uint64{3}}); err == nil {
		t.Fatal("summary referenced a future event")
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = Open(ctx, s.Root())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	latest, err := s.LatestConversationSummary(ctx, conversation.ID)
	if err != nil || latest == nil || latest.ThroughSeq != 2 || latest.Text != "The user asked twice." || len(latest.SourceEventIDs) != 2 || latest.SourceEventIDs[0] != 1 {
		t.Fatalf("reloaded summary=%+v err=%v", latest, err)
	}
}
