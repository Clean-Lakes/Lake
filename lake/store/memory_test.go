package store

import (
	"context"
	"encoding/json"
	"testing"
)

func TestMemoryDefaultsOffAndSeparatesLakeAndProject(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	lake, err := s.CreateLake(ctx, "memory lake", "")
	if err != nil {
		t.Fatal(err)
	}
	conversation, err := s.CreateConversation(ctx, lake.Name)
	if err != nil {
		t.Fatal(err)
	}
	project, err := s.CreateCodeProject(ctx, lake.Name, "project", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	enabled, err := s.MemoryEnabled(ctx, lake.ID)
	if err != nil || enabled {
		t.Fatalf("memory must default off: enabled=%v err=%v", enabled, err)
	}
	user, err := s.AppendAgentEvent(ctx, conversation.ID, AgentEventInput{Kind: "user", Actor: "user", Payload: json.RawMessage(`{"preview":"记住：项目使用 Go 1.25","truncated":false}`)})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.AddMemoryFact(ctx, MemoryFactInput{LakeID: lake.ID, SourceConversationID: conversation.ID, SourceEventSeq: user.Sequence, Text: "项目使用 Go 1.25"}); err == nil {
		t.Fatal("memory was saved while disabled")
	}
	if err := s.SetMemoryEnabled(ctx, lake.ID, true); err != nil {
		t.Fatal(err)
	}
	lakeFact, err := s.AddMemoryFact(ctx, MemoryFactInput{LakeID: lake.ID, SourceConversationID: conversation.ID, SourceEventSeq: user.Sequence, Text: "湖使用 Go 1.25"})
	if err != nil {
		t.Fatal(err)
	}
	projectFact, err := s.AddMemoryFact(ctx, MemoryFactInput{LakeID: lake.ID, ProjectID: project.ID, SourceConversationID: conversation.ID, SourceEventSeq: user.Sequence, Text: "项目使用 SQLite"})
	if err != nil {
		t.Fatal(err)
	}
	general, err := s.ListMemoryFacts(ctx, lake.ID, "")
	if err != nil || len(general) != 1 || general[0].ID != lakeFact.ID {
		t.Fatalf("lake facts: %+v err=%v", general, err)
	}
	contextual, err := s.ListMemoryFacts(ctx, lake.ID, project.ID)
	if err != nil || len(contextual) != 2 || !((contextual[0].ID == projectFact.ID && contextual[1].ID == lakeFact.ID) || (contextual[1].ID == projectFact.ID && contextual[0].ID == lakeFact.ID)) {
		t.Fatalf("project facts: %+v err=%v", contextual, err)
	}
	if err := s.DeleteMemoryFact(ctx, lake.ID, projectFact.ID); err != nil {
		t.Fatal(err)
	}
	contextual, err = s.ListMemoryFacts(ctx, lake.ID, project.ID)
	if err != nil || len(contextual) != 1 {
		t.Fatalf("delete: %+v err=%v", contextual, err)
	}
	if err := s.SetMemoryEnabled(ctx, lake.ID, false); err != nil {
		t.Fatal(err)
	}
	general, err = s.ActiveMemoryFacts(ctx, lake.ID, "")
	if err != nil || len(general) != 0 {
		t.Fatalf("disabled facts leaked into model context: %+v err=%v", general, err)
	}
	general, err = s.ListMemoryFacts(ctx, lake.ID, "")
	if err != nil || len(general) != 1 {
		t.Fatalf("disabled facts unavailable for deletion: %+v err=%v", general, err)
	}
}

func TestMemoryRejectsCrossLakeSourcesAndSensitiveFacts(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	a, err := s.CreateLake(ctx, "a", "")
	if err != nil {
		t.Fatal(err)
	}
	b, err := s.CreateLake(ctx, "b", "")
	if err != nil {
		t.Fatal(err)
	}
	conversation, err := s.CreateConversation(ctx, a.Name)
	if err != nil {
		t.Fatal(err)
	}
	event, err := s.AppendAgentEvent(ctx, conversation.ID, AgentEventInput{Kind: "user", Actor: "user", Payload: json.RawMessage(`{"preview":"fact","truncated":false}`)})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.SetMemoryEnabled(ctx, b.ID, true); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AddMemoryFact(ctx, MemoryFactInput{LakeID: b.ID, SourceConversationID: conversation.ID, SourceEventSeq: event.Sequence, Text: "cross lake"}); err == nil {
		t.Fatal("cross-lake source accepted")
	}
	if err := s.SetMemoryEnabled(ctx, a.ID, true); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AddMemoryFact(ctx, MemoryFactInput{LakeID: a.ID, SourceConversationID: conversation.ID, SourceEventSeq: event.Sequence, Text: "API_KEY=secret"}); err == nil {
		t.Fatal("sensitive fact accepted")
	}
	if _, err := s.AddMemoryFact(ctx, MemoryFactInput{LakeID: a.ID, SourceConversationID: conversation.ID, SourceEventSeq: event.Sequence, Text: "数据库密码是 abc123"}); err == nil {
		t.Fatal("Chinese password fact accepted")
	}
}

func TestMemoryV10UpgradePreservesExistingLake(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	s, err := Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	lake, err := s.CreateLake(ctx, "existing", "")
	if err != nil {
		t.Fatal(err)
	}
	// Reconstruct the pre-v10 fixture from the latest schema.
	if _, err := s.db.ExecContext(ctx, `ALTER TABLE conversation DROP COLUMN remote_workspace_id; DROP TABLE code_workspace; DROP TABLE schedule_grant; DROP TABLE schedule_run; DROP TABLE schedule; DROP TABLE workflow_v2_event; DROP TABLE workflow_v2_node; DROP TABLE workflow_v2_run; DROP TABLE workflow_v2_definition; DROP TABLE specialist_task; DROP TABLE extension_config; DROP TABLE memory_fact; DROP TABLE memory_policy; PRAGMA user_version = 9`); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if _, err := reopened.GetLake(ctx, lake.ID); err != nil {
		t.Fatalf("upgrade lost existing lake: %v", err)
	}
	if enabled, err := reopened.MemoryEnabled(ctx, lake.ID); err != nil || enabled {
		t.Fatalf("v9 upgrade must default off: enabled=%v err=%v", enabled, err)
	}
}
