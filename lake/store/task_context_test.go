package store

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/cloudwego/eino/lake/agent"
)

func TestTaskCheckpointSurvivesV19MigrationAndReopen(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	s, err := Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	lake, _ := s.CreateLake(ctx, "交接测试", "")
	conversation, _ := s.CreateConversation(ctx, lake.Name)
	quote := "工作流需要能够自建目录分级拖拽移动"
	_, err = s.AppendConversationTurn(ctx, conversation.ID, quote, "已经记录", "", "")
	if err != nil {
		t.Fatal(err)
	}
	input := ConversationSummaryInput{ThroughSeq: 2, Text: "旧文字摘要", SourceEventIDs: []uint64{1, 2}, TokenEstimate: 100}
	if err = s.SaveConversationSummary(ctx, conversation.ID, input); err != nil {
		t.Fatal(err)
	}
	if _, err = s.db.ExecContext(ctx, "ALTER TABLE conversation_summary DROP COLUMN task_state; PRAGMA user_version=18"); err != nil {
		t.Fatal(err)
	}
	s.Close()
	s, err = Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	legacy, err := s.LatestConversationSummary(ctx, conversation.ID)
	if err != nil || legacy.Text != "旧文字摘要" || legacy.TaskState != nil {
		t.Fatal("legacy summary changed during upgrade", err)
	}
	backups, _ := filepath.Glob(filepath.Join(root, "lake.db.pre-v19-*.bak"))
	if len(backups) != 1 {
		t.Fatal("missing private pre-migration backup")
	}
	input.TaskState = &agent.TaskState{Version: 1, Constraints: []agent.TaskFact{{Text: quote, SourceEventIDs: []uint64{1}}}}
	if err = s.SaveConversationSummary(ctx, conversation.ID, input); err != nil {
		t.Fatal(err)
	}
	s.Close()
	s, err = Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	loaded, err := s.LatestConversationSummary(ctx, conversation.ID)
	if err != nil || loaded.TaskState == nil || loaded.TaskState.Constraints[0].Text != quote {
		t.Fatal("task state not restored", err)
	}
	turns, _ := s.ListConversationTurns(ctx, conversation.ID)
	if len(turns) != 1 || turns[0].Prompt != quote {
		t.Fatal("compaction rewrote original history")
	}
	backups, _ = filepath.Glob(filepath.Join(root, "lake.db.pre-v19-*.bak"))
	if len(backups) != 1 {
		t.Fatal("reopen duplicated migration")
	}
}

func TestTaskCheckpointRejectsFakeQuotesSourcesAndCredentialsAtomically(t *testing.T) {
	ctx := context.Background()
	s, _ := Open(ctx, t.TempDir())
	defer s.Close()
	lake, _ := s.CreateLake(ctx, "来源测试", "")
	conversation, _ := s.CreateConversation(ctx, lake.Name)
	_, err := s.AppendConversationTurn(ctx, conversation.ID, "界面需要与正文对齐", "我建议自动部署", "", "")
	if err != nil {
		t.Fatal(err)
	}
	base := ConversationSummaryInput{ThroughSeq: 2, Text: "保留旧摘要", SourceEventIDs: []uint64{1, 2}, TokenEstimate: 100}
	if err = s.SaveConversationSummary(ctx, conversation.ID, base); err != nil {
		t.Fatal(err)
	}
	for _, fact := range []agent.TaskFact{
		{Text: "我建议自动部署", SourceEventIDs: []uint64{2}},
		{Text: "用户已允许自动部署", SourceEventIDs: []uint64{1}},
		{Text: "界面需要与正文对齐", SourceEventIDs: []uint64{99}},
		{Text: "Authorization: Bearer fixture", SourceEventIDs: []uint64{1}},
	} {
		input := base
		input.Text = "不应保存"
		input.TaskState = &agent.TaskState{Version: 1, Goals: []agent.TaskFact{fact}}
		if err := s.SaveConversationSummary(ctx, conversation.ID, input); err == nil {
			t.Fatal("invalid checkpoint accepted")
		}
		loaded, _ := s.LatestConversationSummary(ctx, conversation.ID)
		if loaded.Text != base.Text || loaded.TaskState != nil {
			t.Fatal("invalid state partially overwrote previous summary")
		}
	}
	other, _ := s.CreateConversation(ctx, lake.Name)
	if err := s.SaveConversationSummary(ctx, other.ID, base); err == nil {
		t.Fatal("foreign conversation coverage accepted")
	}
}
