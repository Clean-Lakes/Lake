package main

import (
	"bytes"
	"context"
	"encoding/json"
	"testing"

	"github.com/cloudwego/eino/lake/store"
)

func TestMemoryCommandViewsDisablesAndDeletesFacts(t *testing.T) {
	ctx := context.Background()
	s, err := store.Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	lake, err := s.CreateLake(ctx, "memory", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.UseLake(ctx, lake.ID); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	call := func(args ...string) map[string]any {
		output.Reset()
		if err := memoryCommand(ctx, s, args, &output); err != nil {
			t.Fatal(err)
		}
		var result map[string]any
		if err := json.Unmarshal(output.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	if call("show")["enabled"] != false {
		t.Fatal("memory should default off")
	}
	if call("on")["enabled"] != true {
		t.Fatal("memory was not enabled")
	}
	conversation, err := s.CreateConversation(ctx, lake.Name)
	if err != nil {
		t.Fatal(err)
	}
	event, err := s.AppendAgentEvent(ctx, conversation.ID, store.AgentEventInput{Kind: "user", Actor: "user", Payload: json.RawMessage(`{"preview":"记住：湖在上海","truncated":false}`)})
	if err != nil {
		t.Fatal(err)
	}
	fact, err := s.AddMemoryFact(ctx, store.MemoryFactInput{LakeID: lake.ID, SourceConversationID: conversation.ID, SourceEventSeq: event.Sequence, Text: "湖在上海"})
	if err != nil {
		t.Fatal(err)
	}
	if facts := call("show")["facts"].([]any); len(facts) != 1 {
		t.Fatalf("facts=%+v", facts)
	}
	if call("off")["enabled"] != false {
		t.Fatal("memory was not disabled")
	}
	if facts := call("show")["facts"].([]any); len(facts) != 1 {
		t.Fatalf("disabled facts cannot be reviewed: %+v", facts)
	}
	call("delete", fact.ID)
	if facts := call("show")["facts"].([]any); len(facts) != 0 {
		t.Fatalf("fact was not deleted: %+v", facts)
	}
}
