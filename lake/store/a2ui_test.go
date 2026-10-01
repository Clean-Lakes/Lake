package store

import (
	"context"
	"encoding/json"
	"github.com/cloudwego/eino/lake/agent"
	"strings"
	"testing"
)

func TestUIEventPersistsOnlyRedactedSnapshot(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	lake, _ := s.CreateLake(ctx, "ui", "")
	c, err := s.CreateConversation(ctx, lake.Name)
	if err != nil {
		t.Fatal(err)
	}
	snapshot := agent.UISnapshot{SurfaceID: "main", CatalogID: agent.UICatalogID, Revision: 1, Components: []map[string]any{{"id": "root", "component": "Text", "text": map[string]any{"path": "/result"}}}, Data: map[string]any{"result": "token=fixture-sensitive", "api_key": "fixture-sensitive", "nested": map[string]any{"password": "fixture-sensitive"}}}
	body, _ := json.Marshal(snapshot)
	payload, _ := json.Marshal(map[string]any{"ui_json": string(body)})
	event, err := s.AppendAgentEvent(ctx, c.ID, AgentEventInput{Kind: "a2ui", Actor: "agent", Payload: payload})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(event.Payload), "fixture-sensitive") {
		t.Fatal("sensitive UI data persisted")
	}
	if snapshot.Data["api_key"] != "fixture-sensitive" {
		t.Fatal("redaction mutated original data")
	}
	events, err := s.ListAgentEvents(ctx, c.ID, 0, 10)
	if err != nil || len(events) != 1 {
		t.Fatal("UI not durable", err)
	}
}
