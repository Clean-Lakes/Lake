package web

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func memoryV2Fixture(t testing.TB) (*Store, string) {
	t.Helper()
	s, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	p := stringOf(s.CreateProject("Memory V2 fixture")["id"])
	if err := s.migrateMemoryV2(); err != nil {
		t.Fatal(err)
	}
	return s, p
}

func memoryV2Mutation(key string) MemoryMutation {
	return MemoryMutation{Key: key, Type: "project", Description: "发布前检查备份", Body: "发布前先核对备份是否可恢复。", Verification: "user-stated", SourceKind: "manual-ui", Details: &MemoryDetails{KnowledgeKind: "procedure", ScopeKind: "project", FactKey: key}}
}

func TestMemoryV2MigrationQuarantinesAndRemovesCompatibilityContent(t *testing.T) {
	s, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	p := stringOf(s.CreateProject("Legacy")["id"])
	m := memoryV2Mutation("legacy-check")
	s.CommitProjectMemory(p, m)
	m = memoryV2Mutation("forgotten-check")
	s.CommitProjectMemory(p, m)
	s.CommitProjectMemory(p, MemoryMutation{Key: m.Key, ExpectedRevision: 1, Forget: true})
	if err := s.migrateMemoryV2(); err != nil {
		t.Fatal(err)
	}
	entry := s.ReadProjectMemory(p, "legacy-check", false)
	if entry["reviewState"] != "needs_review" || len(entry["resourceIds"].([]string)) != 0 || entry["observedAt"] != "" {
		t.Fatalf("unsafe legacy migration: %v", entry)
	}
	if stringOf(s.ReadProjectMemory(p, "forgotten-check", true)["body"]) != "" {
		t.Fatal("forgotten content migrated")
	}
	if integer(s.read(func() any { return s.row("SELECT count(*) AS n FROM projectMemories")["n"] })) != 0 {
		t.Fatal("V1 reader can still see memory")
	}
	index, err := os.ReadFile(filepath.Join(memoryProjectionPath(s.Dir, p), "MEMORY.md"))
	if err != nil || len(index) != 0 {
		t.Fatalf("legacy file index not empty: %v", err)
	}
	if _, err := os.Stat(filepath.Join(memoryProjectionPath(s.Dir, p), "legacy-check.md")); !os.IsNotExist(err) {
		t.Fatal("legacy body still exists")
	}
	backups, _ := filepath.Glob(filepath.Join(s.Dir, "lake-web.before-memory-v2-*.sqlite"))
	if len(backups) != 1 {
		t.Fatal("migration must back up existing memory once")
	}
	before := s.read(func() any { return jsonText(s.rows("SELECT * FROM projectMemoryEntriesV2 ORDER BY key")) })
	if err := s.migrateMemoryV2(); err != nil {
		t.Fatal(err)
	}
	after := s.read(func() any { return jsonText(s.rows("SELECT * FROM projectMemoryEntriesV2 ORDER BY key")) })
	if before != after {
		t.Fatal("migration is not idempotent")
	}
}

func TestMemoryV2CASForgettingAndExplicitRestore(t *testing.T) {
	s, p := memoryV2Fixture(t)
	m := memoryV2Mutation("release-check")
	s.CommitProjectMemory(p, m)
	expectPanic(t, 409, func() { s.CommitProjectMemory(p, m) })
	m.ExpectedRevision, m.Body = 1, "先检查维护窗口，再检查备份。"
	s.CommitProjectMemory(p, m)
	s.update(func() any {
		s.insertMemoryCandidate(p, "late-job", m.Key, 1, Object{"body": "obsolete body"}, "conflict")
		return nil
	})
	deleted := s.CommitProjectMemory(p, MemoryMutation{Key: m.Key, ExpectedRevision: 2, Forget: true})
	if integer(deleted["revision"]) != 3 {
		t.Fatal(deleted)
	}
	// A repeated HTTP request with the pre-delete revision is idempotent.
	s.CommitProjectMemory(p, MemoryMutation{Key: m.Key, ExpectedRevision: 2, Forget: true})
	for _, table := range []string{"projectMemorySourcesV2", "projectMemoryRevisionsV2", "projectMemoryCandidatesV2"} {
		if n := s.read(func() any { return integer(s.row("SELECT count(*) AS n FROM " + table)["n"]) }).(int); n != 0 {
			t.Fatalf("forgotten data remains in %s", table)
		}
	}
	if _, err := os.Stat(filepath.Join(memoryV2ProjectionPath(s.Dir, p), m.Key+".md")); !os.IsNotExist(err) {
		t.Fatal("forgotten projection remains")
	}
	m.ExpectedRevision = 3
	expectPanic(t, 409, func() { s.CommitProjectMemory(p, m) })
	m.RestoreDeleted = true
	s.CommitProjectMemory(p, m)
	if integer(s.ReadProjectMemory(p, m.Key, false)["revision"]) != 4 {
		t.Fatal("explicit restore did not create a new revision")
	}
}

func TestMemoryV2ScopeValidationConflictAndPinnedLimit(t *testing.T) {
	s, p := memoryV2Fixture(t)
	m := memoryV2Mutation("rule-one")
	m.Details = nil
	expectPanic(t, 422, func() { s.CommitProjectMemory(p, m) })
	m = memoryV2Mutation("rule-one")
	m.Details.AlwaysReference = true
	s.CommitProjectMemory(p, m)
	m.Key, m.Details.FactKey = "rule-two", "rule-two"
	s.CommitProjectMemory(p, m)
	m.Key, m.Details.FactKey = "rule-three", "rule-three"
	expectPanic(t, 429, func() { s.CommitProjectMemory(p, m) })
	m.Details.AlwaysReference, m.Details.FactKey = false, "rule-one"
	expectPanic(t, 409, func() { s.CommitProjectMemory(p, m) })
	m.Details.FactKey, m.Details.KnowledgeKind = "configuration", "configuration"
	expectPanic(t, 422, func() { s.CommitProjectMemory(p, m) })
}

func TestMemoryV2TimesCannotBeRefreshedByWording(t *testing.T) {
	s, p := memoryV2Fixture(t)
	resource := s.read(func() any { return s.row("SELECT id FROM resources WHERE projectId=? LIMIT 1", p)["id"] }).(string)
	m := memoryV2Mutation("service-port")
	m.Details = &MemoryDetails{KnowledgeKind: "configuration", ScopeKind: "resources", ResourceIDs: []string{resource}, FactKey: "service.port"}
	s.CommitProjectMemory(p, m)
	first := s.ReadProjectMemory(p, m.Key, false)
	m.ExpectedRevision, m.Body = 1, "用户补充：该服务使用 8080。"
	s.CommitProjectMemory(p, m)
	next := s.ReadProjectMemory(p, m.Key, false)
	if next["validUntil"] != first["validUntil"] || next["observedAt"] != "" {
		t.Fatal("wording refreshed operational fact")
	}
	until, _ := time.Parse(time.RFC3339Nano, stringOf(first["validUntil"]))
	if time.Until(until) > 24*time.Hour || time.Until(until) < 23*time.Hour {
		t.Fatal("configuration default TTL incorrect")
	}
	s.update(func() any { s.BumpMemoryResourceGeneration(resource, "fixture_connection_change"); return nil })
	if s.ReadProjectMemory(p, m.Key, false)["eligibility"] != "generation_mismatch" {
		t.Fatal("changed connection still eligible")
	}
}

func TestMemoryV2ProjectionRejectsSymlinksAndRetainsDBCommit(t *testing.T) {
	s, p := memoryV2Fixture(t)
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(s.Dir, "memories", "v2")); err != nil {
		t.Fatal(err)
	}
	result := s.CommitProjectMemory(p, memoryV2Mutation("safe-rule"))
	if result["publicationError"] == nil || stringOf(s.ReadProjectMemory(p, "safe-rule", false)["body"]) == "" {
		t.Fatal("unsafe publication lost DB commit or reported success")
	}
	entries, _ := os.ReadDir(outside)
	if len(entries) != 0 {
		t.Fatal("projection followed a symlink")
	}
}

func TestMemoryV2LegacyImportCannotResurrectForgottenEntry(t *testing.T) {
	s, p := memoryV2Fixture(t)
	m := memoryV2Mutation("cannot-resurrect")
	s.CommitProjectMemory(p, m)
	s.CommitProjectMemory(p, MemoryMutation{Key: m.Key, ExpectedRevision: 1, Forget: true})
	// Simulate an old client writing to its own table after downgrade.
	s.update(func() any {
		s.exec(`INSERT INTO projectMemories(projectId,key,type,description,body,markdown,revision,projectRevision,contentHash,verification,createdAt,updatedAt) VALUES(?,?,'project','legacy','legacy content','',1,1,'hash','user-stated',?,?)`, p, m.Key, now(), now())
		return nil
	})
	if err := s.migrateMemoryV2(); err != nil {
		t.Fatal(err)
	}
	if got := s.ReadProjectMemory(p, m.Key, true); stringOf(got["deletedAt"]) == "" || strings.Contains(jsonText(got), "legacy content") {
		t.Fatal("legacy import resurrected a tombstone")
	}
}
