package ai

import (
	"context"
	"testing"
	"time"
)

func manualQuestionFixture(t *testing.T) (*Engine, *session, WorkGoal, context.Context, chan string, nativeOperation) {
	t.Helper()
	e, s, goal, ctx, questions := securityWorkQuestionFixture(t)
	done := make(chan error, 1)
	go func() {
		_, err := e.confirmSecurityWorkProposal(ctx, s, s.state.Config, Call{ID: "work-plan", Name: "work_begin"}, goal)
		done <- err
	}()
	var id string
	select {
	case id = <-questions:
	case err := <-done:
		t.Fatal(err)
	case <-time.After(5 * time.Second):
		t.Fatal("missing plan question")
	}
	if err := e.ReplyQuestion("case", id, map[string][]string{"work_contract": {securityWorkConfirmLabel}}); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	_, goal, err := e.workRow("case", goal.ID)
	if err != nil {
		t.Fatal(err)
	}
	s.mu.Lock()
	execution := *s.state.Config.securityExecution
	s.mu.Unlock()
	attempt, err := e.BeginWorkAttempt("case", goal.ID, goal.Items[0].ID, execution.Task.ID, execution.Owner.RootTurnID, "", "host-bound attempt", goal.Revision)
	if err != nil {
		t.Fatal(err)
	}
	_, goal, err = e.workRow("case", goal.ID)
	if err != nil {
		t.Fatal(err)
	}
	op := managedProofFixture(t, e, goal, attempt, "succeeded", `{"verified_result":"synthetic"}`)
	store, err := e.adkStore()
	if err != nil {
		t.Fatal(err)
	}
	if err = store.DB.Create(&securityResourceRevisionRow{ProjectID: "project", ResourceID: "target-db", StoreID: execution.Task.StoreID, RecoveryEpoch: execution.Task.RecoveryEpoch, ConnectionRevision: 1, ConnectionDigest: hash("connection"), State: "ready"}).Error; err != nil {
		t.Fatal(err)
	}
	if _, err = e.VerifyWorkStep("case", goal.ID, goal.Items[0].ID, goal.Revision); err != nil {
		t.Fatal(err)
	}
	_, goal, err = e.workRow("case", goal.ID)
	if err != nil {
		t.Fatal(err)
	}
	return e, s, goal, ctx, questions, op
}

func TestSecurityManualQuestionRecordsIndependentInteractionWithoutFakeMessage(t *testing.T) {
	e, s, goal, ctx, questions, _ := manualQuestionFixture(t)
	type result struct {
		id  string
		err error
	}
	done := make(chan result, 1)
	go func() {
		id, err := e.askManualSecurityWorkVerification(ctx, s, s.state.Config, Call{ID: "work-result", Name: "work_update"}, goal, goal.Items[0].ID)
		done <- result{id, err}
	}()
	var questionID string
	select {
	case questionID = <-questions:
	case r := <-done:
		t.Fatal(r.err)
	case <-time.After(5 * time.Second):
		t.Fatal("missing result question")
	}
	store, err := e.adkStore()
	if err != nil {
		t.Fatal(err)
	}
	var count int64
	if err = store.DB.Model(&workAcceptanceRecord{}).Where("state = ?", "pass").Count(&count).Error; err != nil || count != 0 {
		t.Fatal("asking accepted its own result", err)
	}
	if err = e.ReplyQuestion("case", questionID, map[string][]string{"manual_acceptance": {securityManualAcceptLabel}}); err != nil {
		t.Fatal(err)
	}
	var accepted result
	select {
	case accepted = <-done:
		if accepted.err != nil {
			t.Fatal(accepted.err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("manual answer not committed")
	}
	var record workAcceptanceRecord
	if err = store.DB.First(&record, "id = ?", accepted.id).Error; err != nil {
		t.Fatal(err)
	}
	if record.SourceKind != "question" || record.SourceInteractionID != questionID || record.SourceMessageID != "actual-user-message" || record.ActionID != "question:"+questionID {
		t.Fatal("question was misrepresented as a new user message")
	}
	if replay, err := e.recordQuestionWorkAcceptance("case", questionID); err != nil || replay != accepted.id {
		t.Fatal("same human action duplicated", err)
	}
	_, current, err := e.workRow("case", goal.ID)
	if err != nil {
		t.Fatal(err)
	}
	if current.Items[0].Status != "completed" {
		t.Fatal("manual condition not completed")
	}
	steps, err := acceptedStepsTx(store.DB, current)
	if err != nil || steps[0].State != "pass" {
		t.Fatal("independent question source was not revalidated", err)
	}
	if err = store.DB.Model(&securityConfirmationQuestionRow{}).Where("question_id = ?", questionID).Update("answers", `{"manual_acceptance":["other"]}`).Error; err != nil {
		t.Fatal(err)
	}
	steps, err = acceptedStepsTx(store.DB, current)
	if err != nil || steps[0].State == "pass" {
		t.Fatal("changed question source retained a permanent pass", err)
	}
}

func TestSecurityManualQuestionRejectsChangedOriginalOperation(t *testing.T) {
	e, s, goal, ctx, questions, op := manualQuestionFixture(t)
	done := make(chan error, 1)
	go func() {
		_, err := e.askManualSecurityWorkVerification(ctx, s, s.state.Config, Call{ID: "work-result", Name: "work_update"}, goal, goal.Items[0].ID)
		done <- err
	}()
	var questionID string
	select {
	case questionID = <-questions:
	case err := <-done:
		t.Fatal(err)
	case <-time.After(5 * time.Second):
		t.Fatal("missing result question")
	}
	store, err := e.adkStore()
	if err != nil {
		t.Fatal(err)
	}
	if err = store.DB.Model(&nativeOperation{}).Where("id = ?", op.ID).Update("status", "unknown").Error; err != nil {
		t.Fatal(err)
	}
	if err = e.ReplyQuestion("case", questionID, map[string][]string{"manual_acceptance": {securityManualAcceptLabel}}); err != nil {
		t.Fatal(err)
	}
	select {
	case err = <-done:
		if err == nil {
			t.Fatal("stale human answer reconciled unknown effects")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("changed result did not reject")
	}
	var count int64
	if err = store.DB.Model(&workAcceptanceRecord{}).Where("state = ?", "pass").Count(&count).Error; err != nil || count != 0 {
		t.Fatal("changed result accepted", err)
	}
}
