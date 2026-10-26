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

func TestSRECompletedReadOnlyRestartKeepsAuditAndUsesCurrentPilot(t *testing.T) {
	b, sid, rid, old := sreStoreFixture(t)
	old, err := b.Store.MutateSRETask(sid, old.ID, 0, "completed_fixture", func(v *ai.SRETask) error {
		v.Status = "completed"
		v.Outcome = "inconclusive"
		v.Plans = []ai.SREPlanRevision{{TaskType: "investigation", Scope: []string{rid}, Steps: []ai.SREPlanStep{{ID: "observe", Kind: "observe"}}}}
		v.Attempts = []ai.SREStepAttempt{{ID: "a", Status: "succeeded", Operations: []ai.SREOperation{{ID: "o", Risk: "readonly", Status: "succeeded"}, {ID: "blocked", Risk: "write", Status: "not_executed"}, {ID: "declined", Risk: "write", Status: "rejected"}}}}
		return nil
	})
	must(err)
	enabled, automatic := true, true
	b.Store.UpdatePilotSettings(stringOf(b.Store.Session(sid)["projectId"]), 0, &enabled, &automatic)
	fresh, err := b.Store.RestartSREInvestigation(sid, old.ID, "repeat_finished", "plan_only", 128000)
	must(err)
	if fresh.ID == old.ID || fresh.Goal != old.Goal || jsonText(fresh.Scope) != jsonText(old.Scope) || fresh.Pilot == nil || !fresh.Pilot.AutoAdvance || len(fresh.Attempts) != 0 {
		t.Fatal("rerun did not create a fresh observation with current defaults")
	}
	saved, err := b.Store.LoadSRETask(sid, old.ID)
	must(err)
	if jsonText(saved) != jsonText(old) {
		t.Fatal("rerun rewrote completed history")
	}
	duplicate, err := b.Store.RestartSREInvestigation(sid, old.ID, "repeat_finished", "plan_only", 128000)
	must(err)
	if duplicate.ID != fresh.ID {
		t.Fatal("retry duplicated the new task")
	}
	if _, err = b.Store.RestartSREInvestigation(sid, old.ID, "another_repeat", "assist", 128000); err != nil {
		t.Fatal("prior draft blocked a separately requested repeat", err)
	}
	saved, err = b.Store.LoadSRETask(sid, old.ID)
	must(err)
	if jsonText(saved) != jsonText(old) {
		t.Fatal("additional restart modified completed history")
	}
	if _, err = b.Store.RestartSREInvestigation("foreign", old.ID, "foreign_repeat", "assist", 128000); err == nil {
		t.Fatal("cross-session restart allowed")
	}
}

func TestSRECompletedRestartCannotReplayChangesOrUnfinishedOperations(t *testing.T) {
	for _, tc := range []struct{ name, kind, risk, status string }{{"change-plan", "act", "readonly", "succeeded"}, {"prior-change", "observe", "change", "succeeded"}, {"unknown-change", "observe", "change", "unknown"}, {"still-dispatched", "observe", "readonly", "dispatched"}} {
		t.Run(tc.name, func(t *testing.T) {
			b, sid, _, old := sreStoreFixture(t)
			old, err := b.Store.MutateSRETask(sid, old.ID, 0, "fixture", func(v *ai.SRETask) error {
				v.Status = "completed"
				v.Plans = []ai.SREPlanRevision{{TaskType: "investigation", Steps: []ai.SREPlanStep{{Kind: tc.kind}}}}
				v.Attempts = []ai.SREStepAttempt{{Operations: []ai.SREOperation{{Risk: tc.risk, Status: tc.status}}}}
				return nil
			})
			must(err)
			if _, err = b.Store.RestartSREInvestigation(sid, old.ID, "unsafe_repeat", "assist", 128000); err == nil {
				t.Fatal("unsafe replay accepted")
			}
			saved, err := b.Store.LoadSRETask(sid, old.ID)
			must(err)
			if saved.Revision != old.Revision {
				t.Fatal("rejected restart changed history")
			}
		})
	}
}

func TestSREHistoricalCompletionCannotOverrideLaterOrdinaryReply(t *testing.T) {
	b, sid, _, old := sreStoreFixture(t)
	_, err := b.Store.MutateSRETask(sid, old.ID, 0, "fixture", func(v *ai.SRETask) error { v.Status = "completed"; v.Outcome = "inconclusive"; return nil })
	must(err)
	// Different fractional precision must not break the chronological comparison.
	b.Store.update(func() any {
		task := b.Store.sreTask(sid, old.ID)
		task.UpdatedAt = "2020-01-01T00:00:00Z"
		b.Store.exec("UPDATE sreTasks SET body=?,updatedAt=? WHERE id=?", jsonText(task), task.UpdatedAt, old.ID)
		return nil
	})
	b.Store.AddMessage(sid, "user", "解释刚才的结果，不要重跑", nil)
	b.syncSRESessionStatus(sid)
	if b.Store.Session(sid)["status"] != "completed" {
		t.Fatal("historical result overwrote ordinary reply status")
	}
	_, err = b.Store.MutateSRETask(sid, old.ID, 0, "unknown_fixture", func(v *ai.SRETask) error {
		v.Attempts = []ai.SREStepAttempt{{Operations: []ai.SREOperation{{Risk: "change", Status: "unknown"}}}}
		return nil
	})
	must(err)
	b.Store.AddMessage(sid, "user", "解释未核实状态", nil)
	b.syncSRESessionStatus(sid)
	if b.Store.Session(sid)["status"] != "failed" {
		t.Fatal("ordinary reply hid an unknown change")
	}
	// A pause or question left over from an earlier turn stays resumable in the
	// transcript but must not fail the later ordinary reply.
	for _, status := range []string{"paused", "waiting_input", "draft"} {
		_, err = b.Store.MutateSRETask(sid, old.ID, 0, "stale_"+status, func(v *ai.SRETask) error {
			v.Status = status
			v.Attempts = nil
			return nil
		})
		must(err)
		b.Store.update(func() any {
			task := b.Store.sreTask(sid, old.ID)
			task.UpdatedAt = "2020-01-01T00:00:00Z"
			b.Store.exec("UPDATE sreTasks SET body=?,updatedAt=? WHERE id=?", jsonText(task), task.UpdatedAt, old.ID)
			return nil
		})
		b.Store.AddMessage(sid, "user", "继续回答上一个问题", nil)
		b.syncSRESessionStatus(sid)
		if b.Store.Session(sid)["status"] != "completed" {
			t.Fatal("historical " + status + " overwrote ordinary reply status")
		}
	}
	// Unresolved effects keep the session blocked even when the task is old.
	b.Store.update(func() any {
		task := b.Store.sreTask(sid, old.ID)
		task.Attempts = []ai.SREStepAttempt{{Operations: []ai.SREOperation{{Risk: "change", Status: "unknown"}}}}
		task.UpdatedAt = "2020-01-01T00:00:00Z"
		b.Store.exec("UPDATE sreTasks SET body=?,updatedAt=? WHERE id=?", jsonText(task), task.UpdatedAt, old.ID)
		return nil
	})
	b.Store.AddMessage(sid, "user", "解释旧任务未核实状态", nil)
	b.syncSRESessionStatus(sid)
	if b.Store.Session(sid)["status"] != "failed" {
		t.Fatal("historical pause hid an unknown change")
	}
}

func TestSRETasksDoNotReserveSessionSlots(t *testing.T) {
	for _, status := range []string{"draft", "paused", "waiting_input", "waiting_approval", "active"} {
		t.Run(status, func(t *testing.T) {
			b, sid, rid, old := sreStoreFixture(t)
			saved, err := b.Store.MutateSRETask(sid, old.ID, 0, "fixture", func(v *ai.SRETask) error { v.Status = status; return nil })
			must(err)
			fresh, err := b.Store.CreateSRETask(ai.SRETask{SessionID: sid, RequestID: "independent", Goal: "独立的新任务", Scope: []string{rid}, Mode: "plan_only", TokenBudget: 128000})
			must(err)
			if fresh.ID == old.ID || fresh.Goal != "独立的新任务" {
				t.Fatal("new goal reused old task")
			}
			retained, err := b.Store.LoadSRETask(sid, old.ID)
			must(err)
			if jsonText(retained) != jsonText(saved) {
				t.Fatal("creating a task changed prior task history")
			}
			duplicate, err := b.Store.CreateSRETask(ai.SRETask{SessionID: sid, RequestID: "independent"})
			must(err)
			if duplicate.ID != fresh.ID {
				t.Fatal("request retry duplicated new task")
			}
		})
	}
}

func TestSRELegacySessionSlotIndexIsRemovedOnOpen(t *testing.T) {
	dir := t.TempDir()
	store, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	project := stringOf(store.CreateProject("Legacy task slot")["id"])
	resource := stringOf(store.CreateResource(project, "演示主机", "local", Object{})["id"])
	session := stringOf(store.CreateSession(project, "独立目标", []string{resource})["id"])
	old, err := store.CreateSRETask(ai.SRETask{SessionID: session, RequestID: "old", Goal: "旧目标", Scope: []string{resource}, Mode: "plan_only"})
	if err != nil {
		t.Fatal(err)
	}
	old, err = store.MutateSRETask(session, old.ID, 0, "paused_fixture", func(task *ai.SRETask) error { task.Status = "paused"; return nil })
	if err != nil {
		t.Fatal(err)
	}
	_, err = store.db.Exec("CREATE UNIQUE INDEX sreTasks_one_active ON sreTasks(sessionId) WHERE status IN ('draft','active','waiting_input','waiting_approval','paused')")
	if err != nil {
		t.Fatal(err)
	}
	if err = store.Close(); err != nil {
		t.Fatal(err)
	}
	store, err = OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if row := store.row("SELECT name FROM sqlite_master WHERE type='index' AND name='sreTasks_one_active'"); row != nil {
		t.Fatal("legacy session slot index survived reopen")
	}
	fresh, err := store.CreateSRETask(ai.SRETask{SessionID: session, RequestID: "fresh", Goal: "新目标", Scope: []string{resource}, Mode: "plan_only"})
	if err != nil || fresh.ID == old.ID {
		t.Fatal("legacy paused task blocked the new goal", err)
	}
	retained, err := store.LoadSRETask(session, old.ID)
	if err != nil || jsonText(retained) != jsonText(old) {
		t.Fatal("migration changed the old task", err)
	}
	duplicate, err := store.CreateSRETask(ai.SRETask{SessionID: session, RequestID: "fresh"})
	if err != nil || duplicate.ID != fresh.ID {
		t.Fatal("request identity lost on upgrade", err)
	}
}
