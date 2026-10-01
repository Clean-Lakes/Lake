package store

import (
	"context"
	"strings"
	"testing"
)

func TestExecutionScopeRedactionAndReference(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if _, err = s.CreateLake(ctx, "task", ""); err != nil {
		t.Fatal(err)
	}
	c, _ := s.CreateConversation(ctx, "task")
	other, _ := s.CreateConversation(ctx, "task")
	r := ExecutionRecord{ID: "run", ScopeID: "project", SessionID: "shell", Actor: "user", Command: "printf test", Stdout: "API_KEY=dummy-private-value", Stderr: strings.Repeat("字", 17000), Status: "completed", ExitCode: 0}
	saved, event, err := s.AppendExecution(ctx, c.ID, r)
	if err != nil {
		t.Fatal(err)
	}
	if saved.Stdout != "[redacted]" || !saved.Truncated || strings.Contains(string(event.Payload), "dummy-private-value") {
		t.Fatal("execution was not redacted/bounded")
	}
	if _, err = s.GetExecution(ctx, other.ID, saved.Sequence); err == nil {
		t.Fatal("cross conversation reference allowed")
	}
	prompt, _ := AddExecutionReferences("解释一下", []uint64{saved.Sequence})
	with, err := s.WithExecutionContext(ctx, c.ID, prompt)
	if err != nil || !strings.Contains(with, "不可信资料") || strings.Contains(with, "dummy-private-value") {
		t.Fatal("invalid referenced context")
	}
	r.ID = "incomplete"
	r.Status = "running"
	started, _, err := s.AppendExecution(ctx, c.ID, r)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.GetExecution(ctx, c.ID, started.Sequence); err == nil {
		t.Fatal("unfinished record referenced as final")
	}
}
