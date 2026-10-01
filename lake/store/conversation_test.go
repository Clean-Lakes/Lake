package store

import (
	"context"
	"database/sql"
	"encoding/base64"
	"path/filepath"
	"testing"
)

func TestConversationImagePersistsAcrossReopen(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	s, err := Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	lake, err := s.CreateLake(ctx, "图片湖", "")
	if err != nil {
		t.Fatal(err)
	}
	conversation, err := s.CreateConversation(ctx, lake.Name)
	if err != nil {
		t.Fatal(err)
	}
	png := base64.StdEncoding.EncodeToString([]byte("\x89PNG\r\n\x1a\nimage"))
	image := ImageAttachment{Name: "example.png", MIMEType: "image/png", Data: png}
	if _, err := s.AppendConversationTurnWithImages(ctx, conversation.ID, "看图", "这是一张图", "这是一张图", "", []ImageAttachment{image}); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	turns, err := s.ListConversationTurns(ctx, conversation.ID)
	if err != nil || len(turns) != 1 || len(turns[0].Images) != 1 || turns[0].Images[0] != image {
		t.Fatalf("image was not restored: turns=%+v err=%v", turns, err)
	}
}

func TestConversationTurnAndTimelineCommitTogether(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	lake, err := s.CreateLake(ctx, "timeline lake", "")
	if err != nil {
		t.Fatal(err)
	}
	conversation, err := s.CreateConversation(ctx, lake.Name)
	if err != nil {
		t.Fatal(err)
	}
	turn, err := s.AppendConversationTurn(ctx, conversation.ID, "question", "answer", "answer", "")
	if err != nil {
		t.Fatal(err)
	}
	if turn.UserEventSeq != 1 || turn.AssistantEventSeq != 2 {
		t.Fatalf("committed turn omitted event positions: %+v", turn)
	}
	events, err := s.ListAgentEvents(ctx, conversation.ID, 0, 10)
	if err != nil || len(events) != 2 || events[0].Kind != "user" || events[1].Kind != "assistant" || events[0].LegacyTurnID != turn.ID || events[1].LegacyTurnID != turn.ID {
		t.Fatalf("legacy turn and events disagree: turn=%+v events=%+v err=%v", turn, events, err)
	}
	if _, err := s.db.ExecContext(ctx, `CREATE TRIGGER reject_assistant_event BEFORE INSERT ON conversation_event WHEN NEW.kind='assistant' BEGIN SELECT RAISE(ABORT,'test rejection'); END`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AppendConversationTurn(ctx, conversation.ID, "second", "must roll back", "", ""); err == nil {
		t.Fatal("event failure did not roll back legacy turn")
	}
	turns, err := s.ListConversationTurns(ctx, conversation.ID)
	if err != nil || len(turns) != 1 {
		t.Fatalf("failed append left a legacy turn: turns=%+v err=%v", turns, err)
	}
}

func TestConversationTurnLinksPreviouslyPersistedUserEvent(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	lake, err := s.CreateLake(ctx, "timeline lake", "")
	if err != nil {
		t.Fatal(err)
	}
	conversation, err := s.CreateConversation(ctx, lake.Name)
	if err != nil {
		t.Fatal(err)
	}
	user, err := s.AppendAgentEvent(ctx, conversation.ID, AgentEventInput{Kind: "user", Actor: "user", Payload: []byte(`{"preview":"question"}`)})
	if err != nil {
		t.Fatal(err)
	}
	turn, err := s.AppendConversationTurnWithDetailsAndUserEvent(ctx, conversation.ID, "question", "answer", "answer", "", nil, nil, user.Sequence)
	if err != nil {
		t.Fatal(err)
	}
	events, err := s.ListAgentEvents(ctx, conversation.ID, 0, 10)
	if err != nil || len(events) != 2 || events[0].Sequence != user.Sequence || events[0].LegacyTurnID != turn.ID || events[1].Kind != "assistant" || events[1].LegacyTurnID != turn.ID || turn.UserEventSeq != user.Sequence || turn.AssistantEventSeq != events[1].Sequence {
		t.Fatalf("saved turn/event link: turn=%+v events=%+v err=%v", turn, events, err)
	}
}

func TestConversationsMigrateAndPersistByLake(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	db, err := sql.Open("sqlite", filepath.Join(root, "lake.db"))
	if err != nil {
		t.Fatal(err)
	}
	for _, migration := range []string{migrationV1, migrationV2} {
		if _, err := db.ExecContext(ctx, migration); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.ExecContext(ctx, "PRAGMA user_version = 2"); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	s, err := Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	first, err := s.CreateLake(ctx, "测试湖", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateLake(ctx, "生产湖", ""); err != nil {
		t.Fatal(err)
	}
	if err := s.UseLake(ctx, first.ID); err != nil {
		t.Fatal(err)
	}
	conversation, err := s.CreateConversation(ctx, "测试湖")
	if err != nil {
		t.Fatal(err)
	}
	other, err := s.CreateConversation(ctx, "生产湖")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.AppendConversationTurn(ctx, conversation.ID, "查看 CPU 占用", "CPU 空闲 90%", "CPU 空闲 90%\n耗时 1 秒", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AppendConversationTurn(ctx, conversation.ID, "再查内存", "内存 1G", "内存 1G", ""); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	s, err = Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	got, err := s.GetConversation(ctx, conversation.ID)
	if err != nil || got.Title != "查看 CPU 占用" || got.Lake != "测试湖" {
		t.Fatalf("conversation=%+v err=%v", got, err)
	}
	turns, err := s.ListConversationTurns(ctx, conversation.ID)
	if err != nil || len(turns) != 2 || turns[0].Prompt != "查看 CPU 占用" || turns[1].Prompt != "再查内存" {
		t.Fatalf("turns=%+v err=%v", turns, err)
	}
	otherTurns, err := s.ListConversationTurns(ctx, other.ID)
	if err != nil || len(otherTurns) != 0 {
		t.Fatalf("other turns=%+v err=%v", otherTurns, err)
	}
	if _, err := s.RenameConversation(ctx, conversation.ID, "服务器巡检"); err != nil {
		t.Fatal(err)
	}
	if err := s.ArchiveConversation(ctx, conversation.ID); err != nil {
		t.Fatal(err)
	}
	items, err := s.ListConversations(ctx)
	if err != nil || len(items) != 1 || items[0].ID != other.ID {
		t.Fatalf("active=%+v err=%v", items, err)
	}
	if _, err := s.GetConversation(ctx, conversation.ID); err != ErrNotFound {
		t.Fatalf("archived conversation error=%v", err)
	}
	archived, err := s.ListArchivedConversations(ctx)
	if err != nil || len(archived) != 1 || archived[0].ID != conversation.ID {
		t.Fatalf("archived=%+v err=%v", archived, err)
	}
	if err := s.RestoreConversation(ctx, conversation.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetConversation(ctx, conversation.ID); err != nil {
		t.Fatal(err)
	}
}
