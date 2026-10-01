package main

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cloudwego/eino/lake/store"
)

func taskFixture(t *testing.T) (*App, *store.Store, store.Conversation) {
	t.Helper()
	ctx := context.Background()
	root := t.TempDir()
	t.Setenv("LAKE_HOME", root)
	data, err := store.Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { data.Close() })
	_, err = data.CreateLake(ctx, "task", "")
	if err != nil {
		t.Fatal(err)
	}
	project, err := data.CreateCodeProject(ctx, "task", "app", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	c, err := data.CreateConversation(ctx, "task")
	if err != nil {
		t.Fatal(err)
	}
	c, err = data.SetConversationProject(ctx, c.ID, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal([]store.CodeProject{project})
	stub := filepath.Join(t.TempDir(), "lake-stub")
	if err := os.WriteFile(stub, []byte("#!/bin/sh\nprintf '%s' '"+string(raw)+"'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("LAKE_CLI_PATH", stub)
	a := NewApp()
	a.ctx = ctx
	a.taskEvent = func(string, any) {}
	a.approvalDialog = func(string, string, string) (bool, error) { return true, nil }
	t.Cleanup(func() { a.shutdown(ctx) })
	return a, data, c
}

func TestAIRequestCannotOverlapManualTerminalApproval(t *testing.T) {
	a, _, c := taskFixture(t)
	a.process = &exec.Cmd{}
	a.conversationID = c.ID
	replies, err := os.CreateTemp(t.TempDir(), "requests")
	if err != nil {
		t.Fatal(err)
	}
	a.stdin = replies
	entered, release := make(chan struct{}), make(chan struct{})
	a.approvalDialog = func(string, string, string) (bool, error) {
		close(entered)
		<-release
		return true, nil
	}
	done := make(chan error, 1)
	go func() { _, err := a.RunTaskCommand(c.ID, "printf approved"); done <- err }()
	<-entered
	if err := a.Ask("overlap", "检查状态"); err == nil {
		t.Error("AI request overlapped manual command approval")
	}
	if err := a.CloseTaskTerminal(c.ID); err == nil {
		t.Error("terminal closed while command approval was pending")
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if err := a.Ask("next", "检查状态"); err != nil {
		t.Fatal(err)
	}
	a.process, a.stdin = nil, nil
	replies.Close()
}
func TestTaskTerminalPersistsHistoryAndRejectsUnapprovedCommands(t *testing.T) {
	a, data, c := taskFixture(t)
	a.approvalDialog = func(string, string, string) (bool, error) { return false, nil }
	if _, err := a.RunTaskCommand(c.ID, "touch denied"); err == nil {
		t.Fatal("unapproved command accepted")
	}
	if _, err := os.Stat(filepath.Join(c.ProjectPath, "denied")); !os.IsNotExist(err) {
		t.Fatal("unapproved operation executed")
	}
	a.approvalDialog = func(string, string, string) (bool, error) { return true, nil }
	raw, err := a.RunTaskCommand(c.ID, "export LAKE_TASK_VALUE=kept")
	if err != nil {
		t.Fatal(err)
	}
	var first store.ExecutionRecord
	if err := json.Unmarshal([]byte(raw), &first); err != nil {
		t.Fatal(err)
	}
	// Restarting the AI process cannot destroy the independent task terminal.
	a.StopConversation()
	raw, err = a.RunTaskCommand(c.ID, `printf '%s' "$LAKE_TASK_VALUE"`)
	if err != nil {
		t.Fatal(err)
	}
	var second store.ExecutionRecord
	json.Unmarshal([]byte(raw), &second)
	if second.Stdout != "kept" || first.SessionID != second.SessionID {
		t.Fatal("task shell state lost")
	}
	persisted, err := data.GetExecution(a.ctx, c.ID, second.Sequence)
	if err != nil || persisted.Stdout != "kept" {
		t.Fatal("terminal result not persisted")
	}
}
func TestTaskCommandHandoffUsesNewResultFromMatchingTask(t *testing.T) {
	a, data, c := taskFixture(t)
	process := &exec.Cmd{}
	a.process = process
	a.conversationID = c.ID
	a.agentRunID = "turn"
	replyFile, err := os.CreateTemp(t.TempDir(), "replies")
	if err != nil {
		t.Fatal(err)
	}
	a.stdin = replyFile
	event := map[string]any{"tool_call_id": "proposal", "kind": "local", "path": c.ProjectPath, "command": "printf proposed"}
	if err := a.acceptCommandProposal(process, c.ID, event); err != nil {
		t.Fatal(err)
	}
	if _, err := a.RunTaskCommand(c.ID, "printf bypass"); err == nil {
		t.Fatal("manual input bypassed agent ownership")
	}
	if err := a.TakeCommandControl("proposal"); err != nil {
		t.Fatal(err)
	}
	if _, err := a.RunProposedCommand("proposal"); err == nil {
		t.Fatal("agent ran while user owned terminal")
	}
	raw, err := a.RunTaskCommand(c.ID, "printf manually-edited")
	if err != nil {
		t.Fatal(err)
	}
	var result store.ExecutionRecord
	json.Unmarshal([]byte(raw), &result)
	other, _ := data.CreateConversation(a.ctx, "task")
	foreign := store.ExecutionRecord{ID: "foreign", ScopeID: c.ProjectID, SessionID: "other", Actor: "user", Command: "printf fake", Status: "completed"}
	foreign, _, err = data.AppendExecution(a.ctx, other.ID, foreign)
	if err != nil {
		t.Fatal(err)
	}
	if err := a.ReturnCommandControl("proposal", foreign.Sequence); err == nil {
		t.Fatal("foreign handoff result accepted")
	}
	if err := a.ReturnCommandControl("proposal", result.Sequence); err != nil {
		t.Fatal(err)
	}
	if err := a.ReturnCommandControl("proposal", result.Sequence); err == nil {
		t.Fatal("handoff replay accepted")
	}
	body, err := os.ReadFile(replyFile.Name())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), "manually-edited") || !strings.Contains(string(body), "command_result") {
		t.Fatal("real handoff result missing")
	}
	a.process = nil
	a.stdin = nil
}
