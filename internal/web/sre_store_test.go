package web

import (
	"errors"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func sreStoreFixture(t *testing.T) (*Server, string, string, ai.SRETask) {
	t.Helper()
	b, h := fixture(t)
	session, resource := newSession(t, h)
	task, err := b.Store.CreateSRETask(ai.SRETask{SessionID: session, RequestID: "request_1", Goal: "SRE fixture", Scope: []string{resource}, Mode: "plan_only", TokenBudget: 128000})
	if err != nil {
		t.Fatal(err)
	}
	return b, session, resource, task
}
func TestSRETaskStoreIdempotencyIsolationAndRollback(t *testing.T) {
	b, session, _, task := sreStoreFixture(t)
	duplicate, err := b.Store.CreateSRETask(ai.SRETask{SessionID: session, RequestID: task.RequestID})
	if err != nil || duplicate.ID != task.ID {
		t.Fatal("request not idempotent", err)
	}
	if _, err = b.Store.LoadSRETask("different_session", task.ID); err == nil {
		t.Fatal("cross-session task exposed")
	}
	_, err = b.Store.MutateSRETask(session, task.ID, task.Revision, "bad", func(v *ai.SRETask) error { v.Goal = "must roll back"; return errors.New("synthetic failure") })
	if err == nil {
		t.Fatal("mutation did not fail")
	}
	got, err := b.Store.LoadSRETask(session, task.ID)
	if err != nil || got.Goal != task.Goal {
		t.Fatal("failed transaction persisted")
	}
	if _, err = b.Store.MutateSRETask(session, task.ID, task.Revision+1, "conflict", func(*ai.SRETask) error { return nil }); err == nil {
		t.Fatal("stale revision accepted")
	}
	events, err := b.Store.SREEvents(session, task.ID, 0, 100)
	if err != nil || len(events) != 1 {
		t.Fatal("rollback left an event", err)
	}
}
func TestSRERestartMarksDispatchUnknownWithoutReplay(t *testing.T) {
	b, session, _, task := sreStoreFixture(t)
	_, err := b.Store.MutateSRETask(session, task.ID, 0, "running", func(v *ai.SRETask) error {
		v.Status = "active"
		v.Runs = []ai.SREPlanRun{{ID: "run", Status: "running"}}
		v.Attempts = []ai.SREStepAttempt{{ID: "attempt", Status: "running", Operations: []ai.SREOperation{{ID: "operation", Status: "dispatched"}}}}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if b.Store.Session(session)["status"] != "investigating" {
		t.Fatal("session status did not track actual task")
	}
	b.Store.RecoverSRETasks()
	v, err := b.Store.LoadSRETask(session, task.ID)
	if err != nil || v.Status != "paused" || v.Runs[0].Status != "interrupted" || v.Attempts[0].Operations[0].Status != "unknown" {
		t.Fatal("restart lost unknown dispatch", err)
	}
	b.Store.RecoverSRETasks()
	events, _ := b.Store.SREEvents(session, task.ID, 0, 100)
	if len(events) != 3 {
		t.Fatal("recovery repeatedly modified historical state")
	}
}
func TestSREMessageSequenceIsTransactionalAndStable(t *testing.T) {
	b, session, _, task := sreStoreFixture(t)
	v, err := b.Store.MutateSRETask(session, task.ID, 0, "finding", func(t *ai.SRETask) error {
		t.AddMessage(ai.SREInvestigator, "real_run", "finding", "真实观察", "")
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	seq := v.Messages[0].Sequence
	if seq == 0 {
		t.Fatal("message has no durable sequence")
	}
	v, err = b.Store.MutateSRETask(session, task.ID, 0, "finding_update", func(t *ai.SRETask) error {
		t.Messages[0].Body = "修订后的真实观察"
		t.Messages[0].Revision++
		return nil
	})
	if err != nil || v.Messages[0].Sequence != seq || len(v.Messages) != 1 {
		t.Fatal("message moved or duplicated", err)
	}
}

func TestSREHumanResolutionIsAuditableAndCannotVerifyRecovery(t *testing.T) {
	b, session, _, task := sreStoreFixture(t)
	task, err := b.Store.MutateSRETask(session, task.ID, 0, "unknown_fixture", func(v *ai.SRETask) error {
		v.Status = "paused"
		v.RecoveryStatus = "unverified"
		v.Attempts = []ai.SREStepAttempt{{ID: "attempt", Status: "unknown", Operations: []ai.SREOperation{{ID: "op", Status: "unknown"}}}}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = b.sreResolveOperation(session, task.ID, task.Revision, "op", "succeeded", ""); err == nil {
		t.Fatal("missing human observation accepted")
	}
	updated, err := b.sreResolveOperation(session, task.ID, task.Revision, "op", "succeeded", "人工检查文件内容与时间，确认动作已经完成")
	if err != nil {
		t.Fatal(err)
	}
	op := updated.Attempts[0].Operations[0]
	if op.ResolvedBy != "local_user" || op.ResolvedAt == "" || updated.Status != "paused" || updated.RecoveryStatus == "verified" || updated.Messages[0].Source != "user" {
		t.Fatal("resolution forged recovery or lost provenance")
	}
	if _, err = b.sreResolveOperation(session, task.ID, updated.Revision, "op", "not_executed", "attempt to change history"); err == nil {
		t.Fatal("resolved operation changed again")
	}
}
