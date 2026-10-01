package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cloudwego/eino/lake/store"
)

func TestWorkbenchTerminalApprovalAndJournal(t *testing.T) {
	ctx := context.Background()
	dataRoot := t.TempDir()
	t.Setenv("LAKE_HOME", dataRoot)
	data, err := store.Open(ctx, dataRoot)
	if err != nil {
		t.Fatal(err)
	}
	lake, err := data.CreateLake(ctx, "ops", "")
	if err != nil {
		t.Fatal(err)
	}
	projectRoot := t.TempDir()
	projectRoot, err = filepath.EvalSymlinks(projectRoot)
	if err != nil {
		t.Fatal(err)
	}
	project := store.CodeProject{ID: "project", LakeID: lake.ID, Lake: lake.Name, Path: projectRoot}
	encoded, _ := json.Marshal([]store.CodeProject{project})
	projectJSON := filepath.Join(t.TempDir(), "projects.json")
	if err := os.WriteFile(projectJSON, encoded, 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("LAKE_TEST_PROJECT_JSON", projectJSON)
	cli := filepath.Join(t.TempDir(), "lake-stub")
	if err := os.WriteFile(cli, []byte("#!/bin/sh\ncat \"$LAKE_TEST_PROJECT_JSON\"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("LAKE_CLI_PATH", cli)
	a := NewApp()
	a.ctx = ctx
	if _, err := a.ListProjectFiles("unknown"); err == nil {
		t.Fatal("unregistered project accepted")
	}
	a.approvalDialog = func(_, _, _ string) (bool, error) { return false, nil }
	if _, err := a.OpenTerminal(project.ID); err == nil {
		t.Fatal("terminal opened without approval")
	}
	a.approvalDialog = func(_, _, _ string) (bool, error) { return true, nil }
	raw, err := a.OpenTerminal(project.ID)
	if err != nil {
		t.Fatal(err)
	}
	var session struct {
		ID   string `json:"id"`
		Root string `json:"root"`
	}
	if err := json.Unmarshal([]byte(raw), &session); err != nil {
		t.Fatal(err)
	}
	if session.ID == "" || session.Root != projectRoot {
		t.Fatalf("session=%+v", session)
	}
	a.approvalDialog = func(_, _, _ string) (bool, error) { return false, nil }
	if _, err := a.RunTerminal(session.ID, "touch forbidden.txt"); err == nil {
		t.Fatal("command ran without approval")
	}
	if _, err := os.Stat(filepath.Join(projectRoot, "forbidden.txt")); !os.IsNotExist(err) {
		t.Fatal("denied command changed workspace")
	}
	a.approvalDialog = func(_, _, _ string) (bool, error) { return true, nil }
	raw, err = a.RunTerminal(session.ID, "printf hello")
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		Stdout string `json:"stdout"`
	}
	if err := json.Unmarshal([]byte(raw), &result); err != nil || result.Stdout != "hello" {
		t.Fatalf("result=%q err=%v", raw, err)
	}
	if err := a.CloseTerminal(session.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := a.RunTerminal(session.ID, "pwd"); err == nil {
		t.Fatal("closed terminal accepted command")
	}
	journal, err := data.ListJournal(ctx, store.JournalFilter{Limit: 20})
	if err != nil {
		t.Fatal(err)
	}
	if len(journal) < 6 {
		t.Fatalf("journal entries=%d", len(journal))
	}
	for _, entry := range journal {
		if strings.Contains(entry.Detail, "printf hello") {
			t.Fatal("journal contains command")
		}
	}
}
