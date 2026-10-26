package web

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func stalePausedTask(t *testing.T, b *Server, session, resource string) ai.SRETask {
	t.Helper()
	task, err := b.Store.CreateSRETask(ai.SRETask{SessionID: session, RequestID: "stale_pause", Goal: "历史暂停任务", Scope: []string{resource}, Mode: "plan_only", TokenBudget: 128000})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = b.Store.MutateSRETask(session, task.ID, 0, "paused_fixture", func(v *ai.SRETask) error { v.Status = "paused"; return nil }); err != nil {
		t.Fatal(err)
	}
	backdateTask(t, b, session, task.ID)
	return task
}

func backdateTask(t *testing.T, b *Server, session, taskID string) {
	t.Helper()
	b.Store.update(func() any {
		saved := b.Store.sreTask(session, taskID)
		saved.UpdatedAt = "2020-01-01T00:00:00Z"
		b.Store.exec("UPDATE sreTasks SET body=?,updatedAt=? WHERE id=?", jsonText(saved), saved.UpdatedAt, taskID)
		return nil
	})
}

func completedTurnFixture(t *testing.T) (*Server, string, ai.SRETask) {
	t.Helper()
	b, h := fixture(t)
	session, resource := newSession(t, h)
	task := stalePausedTask(t, b, session, resource)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			fmt.Fprint(w, `{"data":[]}`)
			return
		}
		emitModel(w, "本轮检查已完成。", nil)
	}))
	t.Cleanup(provider.Close)
	b.Models.Save(&ai.Model{URL: provider.URL + "/v1/chat/completions", Name: "reconcile-fixture", Protocol: "openai"})
	apiTest(t, h, "POST", "/api/sessions/"+session+"/messages", Object{"text": "再查一下"}, 202)
	awaitQueueWorkers(t, b)
	return b, session, task
}

func storedTimingStatus(b *Server, session, messageID string) string {
	for _, row := range b.Store.ReplyTimingRows(session) {
		if stringOf(row["messageId"]) == messageID {
			return stringOf(row["status"])
		}
	}
	return ""
}

func simulateStaleFailure(t *testing.T, b *Server, session string) string {
	t.Helper()
	rows := b.Store.ReplyTimingRows(session)
	if len(rows) != 1 || rows[0]["status"] != "completed" {
		t.Fatalf("new turn was not recorded as completed: %v", rows)
	}
	messageID := stringOf(rows[0]["messageId"])
	b.Store.update(func() any {
		b.Store.exec("UPDATE replyTimings SET status='failed' WHERE sessionId=? AND messageId=?", session, messageID)
		return nil
	})
	b.Store.Status(session, "failed")
	return messageID
}

func TestStalePauseReconciliationRestoresCompletedTurn(t *testing.T) {
	b, session, task := completedTurnFixture(t)
	messageID := simulateStaleFailure(t, b, session)
	b.reconcileStaleSREStatuses()
	if got := storedTimingStatus(b, session, messageID); got != "completed" {
		t.Fatalf("stale pause kept a failed reply timing: %s", got)
	}
	if got := stringOf(b.Store.Session(session)["status"]); got != "completed" {
		t.Fatalf("stale pause kept the session failed: %s", got)
	}
	saved, err := b.Store.LoadSRETask(session, task.ID)
	if err != nil || saved.Status != "paused" || saved.UpdatedAt != "2020-01-01T00:00:00Z" {
		t.Fatalf("reconciliation rewrote task history: %v %+v", err, saved)
	}
	// The correction is idempotent.
	b.reconcileStaleSREStatuses()
	if got := storedTimingStatus(b, session, messageID); got != "completed" {
		t.Fatalf("repeated reconciliation changed the timing: %s", got)
	}
}

func TestStalePauseReconciliationKeepsCurrentPauseAndFailureEvidence(t *testing.T) {
	b, session, task := completedTurnFixture(t)
	messageID := simulateStaleFailure(t, b, session)
	// A pause that happened after the turn started still describes the turn.
	if _, err := b.Store.MutateSRETask(session, task.ID, 0, "current_pause", func(v *ai.SRETask) error { v.Status = "paused"; return nil }); err != nil {
		t.Fatal(err)
	}
	b.reconcileStaleSREStatuses()
	if got := storedTimingStatus(b, session, messageID); got != "failed" {
		t.Fatalf("current pause was repaired away: %s", got)
	}
	if got := stringOf(b.Store.Session(session)["status"]); got != "failed" {
		t.Fatalf("current pause was marked completed: %s", got)
	}
	// A historical pause still keeps a recorded failure inside that turn.
	backdateTask(t, b, session, task.ID)
	b.Store.AddMessage(session, "system", "本轮未完成", nil)
	b.Store.update(func() any {
		at := time.Now().UTC().Add(2 * time.Second).Format(time.RFC3339Nano)
		b.Store.exec("UPDATE replyTimings SET finishedAt=? WHERE sessionId=? AND messageId=?", at, session, messageID)
		return nil
	})
	b.reconcileStaleSREStatuses()
	if got := storedTimingStatus(b, session, messageID); got != "failed" {
		t.Fatalf("failure evidence was repaired away: %s", got)
	}
	if got := stringOf(b.Store.Session(session)["status"]); got != "failed" {
		t.Fatal("failure evidence was hidden by session correction", got)
	}
}

func TestStalePauseReconciliationLeavesEarlierFailureUnchanged(t *testing.T) {
	b, session, _ := completedTurnFixture(t)
	current := simulateStaleFailure(t, b, session)
	older := b.Store.AddMessage(session, "user", "较早失败轮次", nil)
	b.Store.update(func() any {
		b.Store.exec("UPDATE messages SET createdAt=? WHERE id=?", "2019-01-01T00:00:00Z", older["id"])
		b.Store.exec("INSERT INTO replyTimings(messageId,sessionId,startedAt,finishedAt,status) VALUES(?,?,?,?,?)", older["id"], session, "2019-01-01T00:00:00Z", "2019-01-01T00:00:01Z", "failed")
		return nil
	})
	b.reconcileStaleSREStatuses()
	if storedTimingStatus(b, session, current) != "completed" {
		t.Fatal("latest completed turn was not repaired")
	}
	if storedTimingStatus(b, session, stringOf(older["id"])) != "failed" {
		t.Fatal("earlier unproven failure was rewritten")
	}
}

func TestSRECurrentTaskAndUnknownEffectTakePriorityOverHistoricalPause(t *testing.T) {
	b, sid, _, old := sreStoreFixture(t)
	b.Store.AddMessage(sid, "user", "新一轮", nil)
	old.Status = "paused"
	old.UpdatedAt = "2020-01-01T00:00:00Z"
	current := old
	current.ID = "current"
	current.Status = "failed"
	current.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	if got := b.sreSessionStatus(sid, []ai.SRETask{current, old}); got != "failed" {
		t.Fatal("old pause hid current failure", got)
	}
	live := current
	live.Status = "active"
	old.Attempts = []ai.SREStepAttempt{{Operations: []ai.SREOperation{{Risk: "write", Status: "unknown"}}}}
	if got := b.sreSessionStatus(sid, []ai.SRETask{live, old}); got != "failed" {
		t.Fatal("live task hid unresolved old change", got)
	}
}
