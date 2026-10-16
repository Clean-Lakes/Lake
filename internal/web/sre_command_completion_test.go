package web

import (
	"github.com/Clean-Lakes/Lake/internal/ai"
	"testing"
	"time"
)

func TestSRECompletionRequiresUniqueExactTerminalProvenance(t *testing.T) {
	for _, kind := range []string{"success", "failed", "ambiguous", "wrong-origin", "too-late", "missing-exit"} {
		t.Run(kind, func(t *testing.T) {
			b, sid, rid, task := sreStoreFixture(t)
			term := b.Store.CreateTerminal(sid, rid)
			dispatched := time.Now().UTC().Add(-time.Second)
			started := dispatched.Add(20 * time.Millisecond)
			if kind == "too-late" {
				started = dispatched.Add(3 * time.Second)
			}
			origin := sid
			if kind == "wrong-origin" {
				origin = "another-session"
			}
			var code any = 0
			status := "completed"
			if kind == "failed" {
				code = 7
			}
			if kind == "missing-exit" {
				code = nil
				status = "unknown"
			}
			command := "printf COMPLETED"
			b.Store.update(func() any {
				count := 1
				if kind == "ambiguous" {
					count = 2
				}
				for i := 0; i < count; i++ {
					b.Store.exec("INSERT INTO terminalEntries(id,terminalId,actor,command,output,exitCode,createdAt,status,startedAt,finishedAt,originSessionId) VALUES(?,?,?,?,?,?,?,?,?,?,?)", ident(), term["id"], "agent", command, "completed", code, now(), status, started.Format(time.RFC3339Nano), started.Add(time.Millisecond).Format(time.RFC3339Nano), origin)
				}
				return nil
			})
			_, err := b.Store.MutateSRETask(sid, task.ID, 0, "unknown_fixture", func(v *ai.SRETask) error {
				v.Status = "paused"
				v.Attempts = []ai.SREStepAttempt{{ID: "attempt", Status: "unknown", Operations: []ai.SREOperation{{ID: "op", ResourceID: rid, Status: "unknown", Call: ai.Call{Name: "shell", Arguments: jsonText(Object{"command": command})}, DispatchedAt: dispatched.Format(time.RFC3339Nano), Result: "context deadline exceeded"}}}}
				return nil
			})
			must(err)
			listed, err := b.Store.ListSRETasks(sid, 20, "")
			must(err)
			got := listed[0]
			expected := "unknown"
			if kind == "success" {
				expected = "succeeded"
			}
			if kind == "failed" {
				expected = "failed"
			}
			if got.Attempts[0].Operations[0].Status != expected {
				t.Fatal("unproven completion or lost real exit status", kind, got.Attempts[0].Operations[0].Status)
			}
			if got.Status != "paused" || got.Attempts[0].Status == "succeeded" {
				t.Fatal("command completion fabricated role/task completion")
			}
			revision := got.Revision
			again, err := b.Store.ListSRETasks(sid, 20, "")
			must(err)
			if again[0].Revision != revision {
				t.Fatal("completion reconciliation was not idempotent")
			}
		})
	}
}

func TestSREReadOnlyRestartIsAtomicAndKeepsScopeAndHistory(t *testing.T) {
	b, sid, rid, task := sreStoreFixture(t)
	_, err := b.Store.MutateSRETask(sid, task.ID, 0, "paused_fixture", func(v *ai.SRETask) error {
		v.Status = "paused"
		v.Attempts = []ai.SREStepAttempt{{ID: "original", Status: "failed", Operations: []ai.SREOperation{{ID: "op", Status: "unknown"}}}}
		return nil
	})
	must(err)
	if _, err = b.Store.RestartSREInvestigation(sid, task.ID, "restart", "plan_only", 128000); err == nil {
		t.Fatal("restart bypassed unresolved operation")
	}
	old, err := b.Store.LoadSRETask(sid, task.ID)
	must(err)
	if old.Status != "paused" {
		t.Fatal("failed restart cancelled old task")
	}
	_, err = b.Store.MutateSRETask(sid, task.ID, 0, "resolved_fixture", func(v *ai.SRETask) error { v.Attempts[0].Operations[0].Status = "succeeded"; return nil })
	must(err)
	next, err := b.Store.RestartSREInvestigation(sid, task.ID, "restart", "plan_only", 128000)
	must(err)
	old, err = b.Store.LoadSRETask(sid, task.ID)
	must(err)
	if old.Status != "cancelled" || len(old.Attempts) != 1 || next.ID == old.ID || next.Goal != old.Goal || len(next.Scope) != 1 || next.Scope[0] != rid || next.Status != "draft" || len(next.Attempts) != 0 {
		t.Fatal("restart lost audit or changed resource scope")
	}
	duplicate, err := b.Store.RestartSREInvestigation(sid, task.ID, "restart", "plan_only", 128000)
	must(err)
	if duplicate.ID != next.ID {
		t.Fatal("restart replay created duplicate tasks")
	}
	if _, err = b.Engine.ValidateSREHandoff(sid, ai.SREHandoff{Action: "new_task", Goal: "start again", ResourceIDs: []string{rid}}); err == nil {
		t.Fatal("new_task ignored active draft until post-handoff execution")
	}
}
