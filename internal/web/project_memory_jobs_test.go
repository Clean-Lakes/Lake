package web

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func testMemorySnapshot(project, session, turn string, epoch, revision int) ai.MemoryTurnSnapshot {
	snapshot := ai.MemoryTurnSnapshot{ProjectID: project, SessionID: session, TurnID: turn, Epoch: epoch, KnowledgeBaseRevision: revision, UserText: "以后发布前先备份", AssistantText: "明白", ModelRef: "test-model", CapturedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	raw, _ := json.Marshal(snapshot)
	sum := sha256.Sum256(raw)
	snapshot.SnapshotHash = hex.EncodeToString(sum[:])
	return snapshot
}

func TestMemoryOutboxDeduplicationAndTransactionalCommit(t *testing.T) {
	b, h := fixture(t)
	project := stringOf(apiTest(t, h, "POST", "/api/projects", Object{"name": "Memory"}, 201)["id"])
	session := stringOf(apiTest(t, h, "POST", "/api/projects/"+project+"/sessions", Object{"title": "Source"}, 201)["id"])
	snapshot := testMemorySnapshot(project, session, "turn-1", 0, 0)
	if err := b.Store.EnqueueMemoryTurn(snapshot); err != nil {
		t.Fatal(err)
	}
	if err := b.Store.EnqueueMemoryTurn(snapshot); err != nil {
		t.Fatal(err)
	}
	count := b.Store.read(func() any {
		return integer(b.Store.row("SELECT count(*) AS count FROM projectMemoryTurns WHERE projectId=?", project)["count"])
	}).(int)
	if count != 1 {
		t.Fatalf("duplicate turn receipt: %d", count)
	}
	job := b.Store.ClaimMemoryJob()
	if job == nil {
		t.Fatal("job not claimable")
	}
	mutation := MemoryExtractMutation{Operation: "upsert", Key: "backup-before-release", Type: "project", Description: "发布前备份", Body: "本项目发布前先备份。", SourceIDs: []string{"user:0"}, Verification: "user-stated", ExpectedRevision: 0}
	if _, err := b.Store.CommitMemoryExtraction(job, snapshot, []MemoryExtractMutation{{Operation: "upsert", Key: "bad-source", Type: "project", Description: "bad", Body: "bad", SourceIDs: []string{"user:0", "evidence:missing"}, Verification: "user-stated"}}, ai.Usage{}); err == nil {
		t.Fatal("unknown source accepted")
	}
	changed, err := b.Store.CommitMemoryExtraction(job, snapshot, []MemoryExtractMutation{mutation}, ai.Usage{})
	if err != nil || !changed {
		t.Fatalf("commit: %v changed=%v", err, changed)
	}
	if integer(b.Store.MemorySettings(project)["revision"]) != 1 {
		t.Fatal("project revision not advanced")
	}
	if b.Store.ClaimMemoryJob() != nil {
		t.Fatal("settled job was reclaimed")
	}
	if got := stringOf(b.Store.ReadProjectMemory(project, mutation.Key, false)["body"]); got != mutation.Body {
		t.Fatalf("body = %q", got)
	}
}

func TestMemoryLateExtractionCannotRestoreForgottenFact(t *testing.T) {
	b, h := fixture(t)
	project := stringOf(apiTest(t, h, "POST", "/api/projects", Object{"name": "Memory"}, 201)["id"])
	session := stringOf(apiTest(t, h, "POST", "/api/projects/"+project+"/sessions", Object{"title": "Source"}, 201)["id"])
	snapshot := testMemorySnapshot(project, session, "turn-2", 0, 0)
	if err := b.Store.EnqueueMemoryTurn(snapshot); err != nil {
		t.Fatal(err)
	}
	job := b.Store.ClaimMemoryJob()
	if job == nil {
		t.Fatal("job not claimable")
	}
	b.Store.CommitProjectMemory(project, MemoryMutation{Key: "release-rule", Type: "project", Description: "发布规则", Body: "发布前先备份", ExpectedRevision: 0, Verification: "user-stated"})
	b.Store.CommitProjectMemory(project, MemoryMutation{Key: "release-rule", ExpectedRevision: 1, Forget: true})
	mutation := MemoryExtractMutation{Operation: "upsert", Key: "release-rule", Type: "project", Description: "发布规则", Body: "发布前先备份", SourceIDs: []string{"user:0"}, Verification: "user-stated", ExpectedRevision: 0}
	if _, err := b.Store.CommitMemoryExtraction(job, snapshot, []MemoryExtractMutation{mutation}, ai.Usage{}); err == nil {
		t.Fatal("late extraction restored forgotten memory")
	}
	entry := b.Store.ReadProjectMemory(project, "release-rule", true)
	if stringOf(entry["deletedAt"]) == "" || stringOf(entry["body"]) != "" {
		t.Fatalf("forgotten fact reappeared: %v", entry)
	}
}

func TestMemoryRetryRequiresCurrentProjectRevision(t *testing.T) {
	b, h := fixture(t)
	project := stringOf(apiTest(t, h, "POST", "/api/projects", Object{"name": "Retry"}, 201)["id"])
	session := stringOf(apiTest(t, h, "POST", "/api/projects/"+project+"/sessions", Object{"title": "Source"}, 201)["id"])
	snapshot := testMemorySnapshot(project, session, "turn-retry", 0, 0)
	if err := b.Store.EnqueueMemoryTurn(snapshot); err != nil {
		t.Fatal(err)
	}
	job := b.Store.ClaimMemoryJob()
	b.Store.SettleMemoryJob(stringOf(job["jobId"]), stringOf(job["leaseToken"]), "blocked", "model_unavailable", ai.Usage{})
	apiTest(t, h, "POST", "/api/projects/"+project+"/memory-jobs/"+stringOf(job["jobId"])+"/retry", Object{"expectedProjectRevision": 1}, 409)
	apiTest(t, h, "POST", "/api/projects/"+project+"/memory-jobs/"+stringOf(job["jobId"])+"/retry", Object{"expectedProjectRevision": 0}, 200)
	if reclaimed := b.Store.ClaimMemoryJob(); reclaimed == nil || stringOf(reclaimed["jobId"]) != stringOf(job["jobId"]) {
		t.Fatal("retry did not requeue the same receipt")
	}
}

func TestMemoryBodyPaginationPreservesUTF8(t *testing.T) {
	body := strings.Repeat("中", 3000)
	first, line, offset, more, err := memoryBodyPage(body, 0, 0, 200)
	if err != nil || !more || len(first) > 4096 || !utf8.ValidString(first) {
		t.Fatalf("first page: %v", err)
	}
	whole := first
	for more {
		var next string
		next, line, offset, more, err = memoryBodyPage(body, line, offset, 200)
		if err != nil || !utf8.ValidString(next) {
			t.Fatalf("continued page: %v", err)
		}
		whole += next
	}
	if whole != body {
		t.Fatal("pagination lost content")
	}
}

func TestMemoryResolvesOriginalProviderAfterSelection(t *testing.T) {
	b, h := fixture(t)
	a := apiTest(t, h, "POST", "/api/settings/providers", providerFixture("Memory A", "http://localhost:12345/v1", "synthetic-memory-A"), 201)
	bid := apiTest(t, h, "POST", "/api/settings/providers", providerFixture("Memory B", "http://localhost:23456/v1", "synthetic-memory-B"), 201)
	apiTest(t, h, "POST", "/api/settings/model/select", Object{"providerId": a["savedProviderId"], "modelId": "model-one"}, 200)
	identity := ai.ModelIdentity(*b.Models.Active())
	apiTest(t, h, "POST", "/api/settings/model/select", Object{"providerId": bid["savedProviderId"], "modelId": "model-one"}, 200)
	resolved := b.Models.ResolveModelIdentity(identity)
	if resolved == nil || resolved.Key != "synthetic-memory-A" {
		t.Fatal("original provider could not be resolved")
	}
}

func TestMemoryProjectArchiveDoesNotReplayOldJob(t *testing.T) {
	b, h := fixture(t)
	project := stringOf(apiTest(t, h, "POST", "/api/projects", Object{"name": "Archive"}, 201)["id"])
	session := stringOf(apiTest(t, h, "POST", "/api/projects/"+project+"/sessions", Object{"title": "Source"}, 201)["id"])
	if err := b.Store.EnqueueMemoryTurn(testMemorySnapshot(project, session, "archive-turn", 0, 0)); err != nil {
		t.Fatal(err)
	}
	b.Store.ArchiveNavigation("project", project)
	b.Store.RestoreNavigation("project", project)
	if b.Store.ClaimMemoryJob() != nil {
		t.Fatal("archived project replayed an old extraction")
	}
	jobs := b.Store.read(func() any { return b.Store.rows("SELECT status,lastErrorCode FROM projectMemoryJobs") }).([]Object)
	if len(jobs) != 1 || jobs[0]["status"] != "skipped" || jobs[0]["lastErrorCode"] != "project_archived" {
		t.Fatalf("unexpected archived job: %v", jobs)
	}
}

func TestMemoryIntentDoesNotTreatFutureQuestionAsConsent(t *testing.T) {
	if directMemoryIntent("以后怎么办？", "save") || directMemoryIntent("> 请记住这个值", "save") || !directMemoryIntent("请记住：发布前备份", "save") {
		t.Fatal("memory intent classification is unsafe")
	}
}
