package web

import (
	"context"
	"fmt"
	"sync"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func memoryV2JobFixture(t *testing.T, s *Store, p, turn string, mutate ...func(*ai.MemoryTurnSnapshot)) (ai.MemoryTurnSnapshot, Object) {
	t.Helper()
	session := stringOf(s.CreateSession(p, "Source", nil)["id"])
	settings := s.MemorySettings(p)
	snapshot := testMemorySnapshot(p, session, turn, integer(settings["epoch"]), integer(settings["revision"]))
	snapshot.SchemaVersion = 2
	snapshot.UserText = "请记住：以后发布前核对备份。"
	for _, f := range mutate {
		f(&snapshot)
	}
	snapshot = ai.SealMemorySnapshot(snapshot)
	if err := s.EnqueueMemoryTurn(snapshot); err != nil {
		t.Fatal(err)
	}
	job := s.ClaimMemoryJob()
	if job == nil {
		t.Fatal("job not claimable")
	}
	return snapshot, job
}

func TestMemoryV2ConcurrentManualCASOnlyOneWriterWins(t *testing.T) {
	s, p := memoryV2Fixture(t)
	s.CommitMemoryV2(p, memoryV2Mutation("concurrent-rule"))
	var wg sync.WaitGroup
	results := make(chan bool, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			defer func() {
				if p := recover(); p != nil {
					f, ok := p.(*Failure)
					results <- ok && f.Status == 409
				}
			}()
			m := memoryV2Mutation("concurrent-rule")
			m.ExpectedRevision = 1
			m.Body = fmt.Sprintf("备份规则 %d", i)
			s.CommitMemoryV2(p, m)
			results <- false
		}(i)
	}
	wg.Wait()
	close(results)
	conflicts := 0
	for conflict := range results {
		if conflict {
			conflicts++
		}
	}
	if conflicts != 7 || integer(s.ReadProjectMemory(p, "concurrent-rule", false)["revision"]) != 2 {
		t.Fatalf("concurrent CAS: conflicts=%d", conflicts)
	}
}

func TestMemoryV2DispatchBudgetCannotBeBypassedByRetry(t *testing.T) {
	s, p := memoryV2Fixture(t)
	for i := 0; i < 21; i++ {
		_, job := memoryV2JobFixture(t, s, p, fmt.Sprintf("budget-turn-%d", i))
		attempt, allowed := s.ReserveMemoryDispatch(job)
		if allowed != (i < 20) {
			t.Fatalf("dispatch %d allowed=%v", i, allowed)
		}
		if allowed {
			s.settleMemoryDispatch(attempt, ai.Usage{}, "cancelled", "fixture_preemption")
			s.SettleMemoryJob(stringOf(job["jobId"]), stringOf(job["leaseToken"]), "no_op", "", ai.Usage{})
		}
	}
	if row := s.read(func() any {
		return s.row("SELECT status,lastErrorCode FROM projectMemoryJobs ORDER BY rowid DESC LIMIT 1")
	}).(Object); row["status"] != "budget_wait" {
		t.Fatal(row)
	}
}

func TestMemoryV2ForegroundRevokesLeaseAndRejectsLateCommit(t *testing.T) {
	s, p := memoryV2Fixture(t)
	snapshot, job := memoryV2JobFixture(t, s, p, "late-turn")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	b := &Server{Store: s, memoryCancel: cancel, memoryJobID: stringOf(job["jobId"]), memoryLease: stringOf(job["leaseToken"])}
	b.messageMu.Lock()
	b.PauseMemoryExtractionForForeground()
	b.messageMu.Unlock()
	if ctx.Err() == nil {
		t.Fatal("foreground did not cancel extraction")
	}
	m := MemoryExtractMutationV2{Operation: "upsert", Key: "late-rule", Type: "project", Description: "备份规则", Body: "备份后再继续。", SourceIDs: []string{"user:0"}, KnowledgeKind: "procedure", ScopeKind: "project", ResourceIDs: []string{}, FactKey: "release.backup"}
	if _, err := s.CommitMemoryCandidates(job, snapshot, []MemoryExtractMutationV2{m}, ai.Usage{}); err == nil {
		t.Fatal("late model output committed after preemption")
	}
	if total := integer(s.ListProjectMemories(p, "", 0, 50, true, false)["total"]); total != 0 {
		t.Fatal("late memory was stored")
	}
}

func TestMemoryV2ResourceChangeCancelsOnlyItsProjectAndRevokesLease(t *testing.T) {
	s, p := memoryV2Fixture(t)
	_, job := memoryV2JobFixture(t, s, p, "resource-change")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	b := &Server{Store: s, memoryCancel: cancel, memoryJobID: stringOf(job["jobId"]), memoryLease: stringOf(job["leaseToken"])}
	b.messageMu.Lock()
	b.invalidateMemoryExtraction("other-project", "resource_changed")
	if ctx.Err() != nil {
		t.Fatal("unrelated project cancelled extraction")
	}
	b.invalidateMemoryExtraction(p, "resource_changed")
	b.messageMu.Unlock()
	if ctx.Err() == nil {
		t.Fatal("resource change did not cancel extraction")
	}
	row := s.read(func() any {
		return s.row("SELECT status,leaseToken,lastErrorCode FROM projectMemoryJobs WHERE jobId=?", job["jobId"])
	}).(Object)
	if row["status"] != "skipped" || row["leaseToken"] != "" || row["lastErrorCode"] != "resource_changed" {
		t.Fatal("resource change retained commit eligibility")
	}
}

func TestMemoryV2StrictExtractionAndConflictCandidate(t *testing.T) {
	for _, text := range []string{`{"schemaVersion":2,"schemaVersion":2,"mutations":[]}`, `{"schemaVersion":2,"mutations":[]} {}`, `{"schemaVersion":2,"mutations":[],"extra":true}`, `{"schemaVersion":1,"mutations":[]}`} {
		if _, err := parseMemoryExtractionV2(text); err == nil {
			t.Fatal("invalid JSON accepted")
		}
	}
	s, p := memoryV2Fixture(t)
	m := memoryV2Mutation("release-rule")
	s.CommitMemoryV2(p, m)
	snapshot, job := memoryV2JobFixture(t, s, p, "conflict-turn")
	proposal := MemoryExtractMutationV2{Operation: "upsert", Key: m.Key, Type: m.Type, Description: m.Description, Body: "新提议：额外检查维护窗口。", SourceIDs: []string{"user:0"}, ExpectedRevision: 1, KnowledgeKind: "procedure", ScopeKind: "project", ResourceIDs: []string{}, FactKey: m.Key}
	if _, err := s.CommitMemoryCandidates(job, snapshot, []MemoryExtractMutationV2{proposal}, ai.Usage{}); err != nil {
		t.Fatal(err)
	}
	if s.ReadProjectMemory(p, m.Key, false)["body"] != m.Body {
		t.Fatal("conflict silently overwrote existing memory")
	}
	candidate := s.read(func() any { return s.row("SELECT * FROM projectMemoryCandidatesV2 WHERE projectId=?", p) }).(Object)
	if candidate["reason"] != "conflict" {
		t.Fatal("conflict candidate missing")
	}
	m.ExpectedRevision = 1
	m.Body = "用户已明确修正的规则。"
	s.CommitMemoryV2(p, m)
	expectPanic(t, 409, func() {
		s.DecideMemoryCandidate(p, stringOf(candidate["candidateId"]), Object{"action": "accept", "expectedProjectRevision": float64(integer(s.MemorySettings(p)["revision"])), "expectedCandidateHash": candidate["candidateHash"]})
	})
}
