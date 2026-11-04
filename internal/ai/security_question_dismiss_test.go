package ai

import (
	"context"
	"testing"
	"time"
)

func savedSecurityQuestionFixture(t *testing.T) (*Engine, *session, WorkGoal, *QuestionRequest) {
	t.Helper()
	e, s, goal, _, _ := securityWorkQuestionFixture(t)
	req := &QuestionRequest{ID: "security-confirm-saved", Questions: []UserQuestion{{ID: "work_contract", Title: "Confirm plan"}}, Call: &Call{ID: "plan", Name: "work_begin"}, RuntimeSessionID: "must-not-resume-old-input"}
	binding := &securityConfirmationQuestionContext{Row: securityConfirmationQuestionRow{Kind: "work_contract", ProjectID: "project", SessionID: goal.SessionID, RootTurnID: goal.OriginRootTurnID, SourceMessageID: "actual-user-message", GoalID: goal.ID, CallID: "plan", Data: js(map[string]any{"goalId": goal.ID}), ExpiresAt: time.Now().UTC().Add(10 * time.Minute)}}
	if err := e.bindSecurityConfirmationQuestion(withSecurityConfirmationQuestion(context.Background(), binding), s, req); err != nil {
		t.Fatal(err)
	}
	s.mu.Lock()
	s.state.View.Question = req
	s.state.View.Status = "waiting_approval"
	s.cancel = nil
	if err := e.save(s); err != nil {
		t.Fatal(err)
	}
	s.mu.Unlock()
	return e, s, goal, req
}

func TestSecurityObsoleteQuestionCanBeDismissedWithoutAnswerOrReplay(t *testing.T) {
	for _, action := range []string{"skip", "abort", "snapshot", "reject expired answer", "changed root", "completed goal"} {
		t.Run(action, func(t *testing.T) {
			e, s, goal, req := savedSecurityQuestionFixture(t)
			store, _ := e.adkStore()
			if err := store.DB.Model(&securityConfirmationQuestionRow{}).Where("question_id = ?", req.ID).Update("expires_at", time.Now().UTC().Add(-time.Minute)).Error; err != nil {
				t.Fatal(err)
			}
			if action == "changed root" {
				s.mu.Lock()
				s.state.View.RootTurnID = "new-root"
				s.mu.Unlock()
			}
			if action == "completed goal" {
				row, g, err := e.workRow(goal.SessionID, goal.ID)
				if err != nil {
					t.Fatal(err)
				}
				g.Status = "completed"
				g.Summary = "Retain existing result"
				if err = e.writeWorkGoal(&row, &g, false); err != nil {
					t.Fatal(err)
				}
			}
			before, _, _ := e.workRow(goal.SessionID, goal.ID)
			switch action {
			case "skip":
				if err := e.ReplyQuestion(goal.SessionID, req.ID, map[string][]string{}); err != nil {
					t.Fatal(err)
				}
				if err := e.ReplyQuestion(goal.SessionID, req.ID, map[string][]string{}); err != nil {
					t.Fatal("repeat dismissal", err)
				}
			case "abort", "completed goal":
				if err := e.Abort(goal.SessionID); err != nil {
					t.Fatal(err)
				}
			case "reject expired answer":
				if err := e.ReplyQuestion(goal.SessionID, req.ID, map[string][]string{"work_contract": {securityWorkConfirmLabel}}); err == nil {
					t.Fatal("expired answer accepted")
				}
			}
			view, err := e.Snapshot(goal.SessionID)
			if err != nil || view.Question != nil {
				t.Fatal("question remains visible", view.Question, err)
			}
			if e.NeedsQuestionRecovery(goal.SessionID) {
				t.Fatal("obsolete checkpoint remains recoverable")
			}
			var journal securityConfirmationQuestionRow
			if err := store.DB.First(&journal, "question_id = ?", req.ID).Error; err != nil || journal.Status == "pending" || journal.Answers != "" {
				t.Fatal("dismissal fabricated an answer", journal.Status, journal.Answers, err)
			}
			for _, model := range []any{&securityTaskRow{}, &securityTaskGrantRow{}, &workContractRevision{}, &workAcceptanceRecord{}, &nativeOperation{}} {
				var count int64
				if err := store.DB.Model(model).Count(&count).Error; err != nil || count != 0 {
					t.Fatal("dismissal created authority or execution", count, err)
				}
			}
			after, _, _ := e.workRow(goal.SessionID, goal.ID)
			if action != "abort" && js(before) != js(after) {
				t.Fatal("dismissal changed canonical goal")
			}
			next, err := New(e.Dir, nil, nil)
			if err != nil {
				t.Fatal(err)
			}
			next.SecurityRuntime = e.SecurityRuntime
			t.Cleanup(next.Shutdown)
			restored, err := next.Snapshot(goal.SessionID)
			if err != nil || restored.Question != nil {
				t.Fatal("restart resurrected question", err)
			}
		})
	}
}

func TestSecurityAbortDrainsLiveQuestion(t *testing.T) {
	e, s, goal, ctx, questions := securityWorkQuestionFixture(t)
	done := make(chan error, 1)
	go func() {
		_, err := e.confirmSecurityWorkProposal(ctx, s, s.state.Config, Call{ID: "live-plan", Name: "work_begin"}, goal)
		done <- err
	}()
	select {
	case <-questions:
	case <-time.After(5 * time.Second):
		t.Fatal("no live question")
	}
	if err := e.Abort(goal.SessionID); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("abort accepted plan")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("question waiter did not drain")
	}
	view, err := e.Snapshot(goal.SessionID)
	if err != nil || view.Question != nil || view.Status == "running" || view.Status == "waiting_approval" {
		t.Fatal("abort left active input", view.Status, err)
	}
}

func TestSecurityCurrentQuestionSurvivesReadAndWrongDismissal(t *testing.T) {
	e, _, goal, req := savedSecurityQuestionFixture(t)
	view, err := e.Snapshot(goal.SessionID)
	if err != nil || view.Question == nil || view.Question.ID != req.ID {
		t.Fatal("valid checkpoint lost", err)
	}
	if err := e.ReplyQuestion(goal.SessionID, "another-question", map[string][]string{}); err == nil {
		t.Fatal("wrong question ID dismissed current input")
	}
	view, err = e.Snapshot(goal.SessionID)
	if err != nil || view.Question == nil {
		t.Fatal("current input lost", err)
	}
}

func TestSecurityOldQuestionCancellationKeepsNewInput(t *testing.T) {
	e, s, goal, ctx, questions := securityWorkQuestionFixture(t)
	done := make(chan error, 1)
	go func() {
		_, err := e.confirmSecurityWorkProposal(ctx, s, s.state.Config, Call{ID: "old-plan", Name: "work_begin"}, goal)
		done <- err
	}()
	select {
	case <-questions:
	case <-time.After(5 * time.Second):
		t.Fatal("no old question")
	}
	next := &QuestionRequest{ID: "new-question", Questions: []UserQuestion{{ID: "target", Title: "New target"}}}
	nextReply := make(chan map[string][]string, 1)
	s.mu.Lock()
	s.cancel()
	s.state.View.Question = next
	s.questionReply = nextReply
	s.state.View.RootTurnID = "new-turn"
	s.mu.Unlock()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("old question did not drain")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.state.View.Question != next || s.questionReply != nextReply {
		t.Fatal("old cancellation cleared newer input")
	}
}
