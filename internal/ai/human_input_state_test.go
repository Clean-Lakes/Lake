package ai

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

func TestApprovalPublishesResumeBeforeCompletion(t *testing.T) {
	path := filepath.Join(t.TempDir(), "fixture.txt")
	m, closeModel := fakeModel(t, func(n int, _ map[string]any) any {
		if n == 1 {
			return response("", Call{ID: "write-fixture", Name: "append", Arguments: js(map[string]any{"path": path, "content": "once"})})
		}
		return response("complete")
	})
	defer closeModel()
	e := engineFor(t, m, nil)
	events := make(chan string, 32)
	e.Emit = func(event Event) {
		if event.Type == "inputState" {
			events <- str(obj(event.Data)["status"])
		}
		if event.Type == "done" {
			events <- "done"
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- e.Chat(ctx, "case", "append fixture", nil) }()
	p := waitApproval(t, e)
	if err := e.Decision("case", p.ID, true, p.Confirmation); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	resumed := false
	for {
		select {
		case event := <-events:
			if event == "running" {
				resumed = true
			}
			if event == "done" {
				if !resumed {
					t.Fatal("approval left subscribers waiting until completion")
				}
				return
			}
		default:
			t.Fatal("missing completion event")
		}
	}
}

func TestQuestionAnswerPublishesResumeBeforeTurnEnds(t *testing.T) {
	e := engineFor(t, Model{URL: "http://127.0.0.1:1", Name: "fixture"}, nil)
	s, _ := e.get("case")
	events := make(chan string, 8)
	e.Emit = func(event Event) {
		if event.Type == "inputState" {
			events <- str(obj(event.Data)["status"])
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := e.askQuestion(ctx, s, Call{ID: "question", Name: "ask_user_question", Arguments: `{"questions":[{"id":"target","title":"选择测试目标","options":["测试"]}]}`})
		done <- err
	}()
	waitStatus := func(expected string) {
		t.Helper()
		select {
		case status := <-events:
			if status != expected {
				t.Fatalf("input status = %s, want %s", status, expected)
			}
		case <-ctx.Done():
			t.Fatal("missing input state event")
		}
	}
	waitStatus("waiting_approval")
	view, _ := e.Snapshot("case")
	if view.Question == nil || view.Status != "waiting_approval" {
		t.Fatal("question did not wait")
	}
	if err := e.ReplyQuestion("case", view.Question.ID, map[string][]string{"target": {"测试"}}); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	waitStatus("running")
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.state.View.Status != "running" || s.state.View.Question != nil {
		t.Fatal("answer did not resume the live turn")
	}
	// Settling a question must not hide another tool's pending confirmation.
	s.state.View.PendingApprovals = []*Approval{{ID: "remaining"}}
	if err := e.saveHumanInputState(s); err != nil {
		t.Fatal(err)
	}
	waitStatus("waiting_approval")
}
