package ai

import (
	"context"
	"strings"
	"testing"
	"time"
)

func securityWorkQuestionFixture(t *testing.T) (*Engine, *session, WorkGoal, context.Context, chan string) {
	t.Helper()
	e := managedEngineFixture(t, Model{URL: "http://127.0.0.1:1", Name: "metadata-only"})
	s, err := e.get("case")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	s.mu.Lock()
	s.state.SecurityManaged = true
	s.state.SecuritySourceMessageID = "actual-user-message"
	s.state.RootQuestion = "Inspect the requested facts and report verified results"
	s.state.View.RootTurnID = "original-real-root"
	s.state.Runtime = &RuntimeCheckpoint{SchemaVersion: 1, SessionID: "main-runtime-fixture"}
	s.cancel = cancel
	s.mu.Unlock()
	goal, err := e.beginWork(s, "Inspect requested facts", []WorkItem{{ID: "inspect", Title: "Inspect the requested facts"}, {ID: "report", Title: "Report verified results", DependsOn: []string{"inspect"}}})
	if err != nil {
		t.Fatal(err)
	}
	questions := make(chan string, 2)
	e.Emit = func(event Event) {
		if event.Type == "question" {
			id := str(obj(event.Data)["id"])
			if request, ok := event.Data.(*QuestionRequest); ok && request != nil {
				id = request.ID
			}
			if id != "" {
				questions <- id
			}
		}
	}
	return e, s, goal, context.WithValue(ctx, adkToolContextKey{}, struct{}{}), questions
}

func TestSecurityWorkConfirmationUsesActualQuestionWithoutGrantingIO(t *testing.T) {
	e, s, goal, ctx, questions := securityWorkQuestionFixture(t)
	done := make(chan error, 1)
	go func() {
		_, err := e.confirmSecurityWorkProposal(ctx, s, s.state.Config, Call{ID: "original-work-call", Name: "work_begin"}, goal)
		done <- err
	}()
	var questionID string
	select {
	case questionID = <-questions:
	case err := <-done:
		t.Fatal("question not presented", err)
	case <-time.After(5 * time.Second):
		t.Fatal("missing question")
	}
	if !strings.HasPrefix(questionID, "security-confirm-") {
		t.Fatal("question is not host-bound")
	}
	store, err := e.adkStore()
	if err != nil {
		t.Fatal(err)
	}
	var count int64
	if err = store.DB.Model(&securityTaskRow{}).Count(&count).Error; err != nil || count != 0 {
		t.Fatal("proposal created execution authority before human requirements confirmation", err)
	}
	if err = e.ReplyQuestion("case", questionID, map[string][]string{"work_contract": {securityWorkConfirmLabel}}); err != nil {
		t.Fatal(err)
	}
	select {
	case err = <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("confirmation did not resume")
	}
	_, confirmed, err := e.workRow("case", goal.ID)
	if err != nil {
		t.Fatal(err)
	}
	if confirmed.closure == nil || confirmed.closure.Steps[confirmed.Items[0].ID].VerificationMode != "manual" {
		t.Fatal("manual acceptance contract not configured")
	}
	current, err := e.CurrentSecurityExecution(context.Background(), "case")
	if err != nil {
		t.Fatal(err)
	}
	if current.Owner.RootTurnID != "original-real-root" || !current.Task.ExpiresAt.Equal(goal.DeadlineAt) {
		t.Fatal("confirmation changed original root or refreshed task deadline")
	}
	for _, model := range []any{&securityTaskGrantRow{}, &nativeOperation{}, &workAcceptanceRecord{}} {
		if err = store.DB.Model(model).Count(&count).Error; err != nil || count != 0 {
			t.Fatal("requirements question granted, executed or accepted work", err)
		}
	}
	var row securityConfirmationQuestionRow
	if err = store.DB.First(&row, "question_id = ?", questionID).Error; err != nil || row.Status != "activated" || row.SourceMessageID != "actual-user-message" {
		t.Fatal("actual question/source binding not durable", err)
	}
}

func TestSecurityWorkConfirmationRejectionLeavesProposalWithoutTask(t *testing.T) {
	e, s, goal, ctx, questions := securityWorkQuestionFixture(t)
	done := make(chan error, 1)
	go func() {
		_, err := e.confirmSecurityWorkProposal(ctx, s, s.state.Config, Call{ID: "original-work-call", Name: "work_begin"}, goal)
		done <- err
	}()
	var questionID string
	select {
	case questionID = <-questions:
	case err := <-done:
		t.Fatal(err)
	case <-time.After(5 * time.Second):
		t.Fatal("missing question")
	}
	if err := e.ReplyQuestion("case", questionID, map[string][]string{"work_contract": {securityWorkRejectLabel}}); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("rejection confirmed requirements")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("rejection did not return")
	}
	store, err := e.adkStore()
	if err != nil {
		t.Fatal(err)
	}
	var count int64
	if err = store.DB.Model(&securityTaskRow{}).Count(&count).Error; err != nil || count != 0 {
		t.Fatal("rejected proposal created a task", err)
	}
	_, proposal, err := e.workRow("case", goal.ID)
	if err != nil || proposal.closure != nil {
		t.Fatal("rejected proposal became an acceptance contract", err)
	}
}

func TestSecurityWorkConfirmationChangedPlanOrEndedRootCannotActivate(t *testing.T) {
	for _, change := range []string{"plan", "ended_root"} {
		t.Run(change, func(t *testing.T) {
			e, s, goal, ctx, questions := securityWorkQuestionFixture(t)
			done := make(chan error, 1)
			go func() {
				_, err := e.confirmSecurityWorkProposal(ctx, s, s.state.Config, Call{ID: "original-work-call", Name: "work_begin"}, goal)
				done <- err
			}()
			var questionID string
			select {
			case questionID = <-questions:
			case err := <-done:
				t.Fatal(err)
			case <-time.After(5 * time.Second):
				t.Fatal("missing question")
			}
			if change == "plan" {
				row, current, err := e.workRow("case", goal.ID)
				if err != nil {
					t.Fatal(err)
				}
				current.Items[0].Title = "A different unreviewed step"
				if err = e.writeWorkGoal(&row, &current, false); err != nil {
					t.Fatal(err)
				}
			} else {
				s.mu.Lock()
				s.cancel = nil
				s.mu.Unlock()
			}
			if err := e.ReplyQuestion("case", questionID, map[string][]string{"work_contract": {securityWorkConfirmLabel}}); err != nil {
				t.Fatal(err)
			}
			select {
			case err := <-done:
				if err == nil {
					t.Fatal("stale confirmation activated a task")
				}
			case <-time.After(5 * time.Second):
				t.Fatal("stale confirmation did not return")
			}
			store, err := e.adkStore()
			if err != nil {
				t.Fatal(err)
			}
			var count int64
			if err = store.DB.Model(&securityTaskRow{}).Count(&count).Error; err != nil || count != 0 {
				t.Fatal("stale answer created resource execution context", err)
			}
		})
	}
}

func TestSecurityHostConfirmationDoesNotReuseOrdinaryQuestionDecisions(t *testing.T) {
	e, s, goal, ctx, questions := securityWorkQuestionFixture(t)
	qs := []UserQuestion{{ID: "requirements", Title: "Review frozen requirements", Options: []QuestionOption{{Label: "Confirm"}, {Label: "Reject"}}}}
	answers := map[string][]string{"requirements": {"Confirm"}}
	s.mu.Lock()
	s.state.QuestionDecisions = map[string]map[string][]string{hash(s.state.View.RootTurnID + js(qs)): answers}
	s.mu.Unlock()
	binding := &securityConfirmationQuestionContext{Row: securityConfirmationQuestionRow{Kind: "work_contract", ProjectID: "project", SessionID: "case", RootTurnID: "original-real-root", SourceMessageID: "actual-user-message", GoalID: goal.ID, CallID: "host-question", Data: "{}", ExpiresAt: time.Now().UTC().Add(time.Minute)}}
	type response struct {
		value any
		err   error
	}
	done := make(chan response, 1)
	go func() {
		value, err := e.askQuestion(withSecurityConfirmationQuestion(ctx, binding), s, Call{ID: "host-question", Name: "ask_user_question", Arguments: js(map[string]any{"questions": qs})})
		done <- response{value, err}
	}()
	var questionID string
	select {
	case questionID = <-questions:
	case result := <-done:
		t.Fatal("cached model question answer reused", result.err)
	case <-time.After(5 * time.Second):
		t.Fatal("missing new human question")
	}
	if err := e.ReplyQuestion("case", questionID, answers); err != nil {
		t.Fatal(err)
	}
	select {
	case result := <-done:
		if result.err != nil || obj(result.value)["reused"] != false {
			t.Fatal("original host question was not independently answered", result.err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("human answer not delivered")
	}
	store, err := e.adkStore()
	if err != nil {
		t.Fatal(err)
	}
	var count int64
	if err = store.DB.Model(&securityTaskRow{}).Count(&count).Error; err != nil || count != 0 {
		t.Fatal("question answer alone created a task", err)
	}
}
