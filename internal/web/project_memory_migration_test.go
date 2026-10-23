package web

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func TestMemoryV2MigrationBackupAndTransactionFailuresLeaveV1Intact(t *testing.T) {
	s, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	p := stringOf(s.CreateProject("Migration failure")["id"])
	s.CommitProjectMemory(p, memoryV2Mutation("legacy-rule"))
	dir := s.Dir
	s.Dir = filepath.Join(dir, "missing-parent", "missing-home")
	if err := s.migrateMemoryV2(); err == nil {
		t.Fatal("backup failure did not stop migration")
	}
	s.Dir = dir
	if s.row("SELECT name FROM sqlite_master WHERE name='projectMemoryEntriesV2'") != nil {
		t.Fatal("backup failure changed schema")
	}
	s.update(func() any {
		s.exec(`INSERT INTO projectMemories(projectId,key,type,description,body,markdown,revision,projectRevision,contentHash,verification,createdAt,updatedAt) VALUES(?,'zz-invalid.name','project','bad','bad','',1,1,'hash','user-stated',?,?)`, p, now(), now())
		return nil
	})
	if err := s.migrateMemoryV2(); err == nil {
		t.Fatal("invalid legacy record did not abort transaction")
	}
	if s.row("SELECT name FROM sqlite_master WHERE name='projectMemoryMetaV2'") != nil || integer(s.row("SELECT count(*) AS n FROM projectMemories")["n"]) != 2 {
		t.Fatal("failed migration left partial state")
	}
	if s.ReadProjectMemory(p, "legacy-rule", false)["body"] == "" {
		t.Fatal("legacy content lost during rollback")
	}
}

func TestMemoryV2ProjectionFailureIsRecoverableAfterCommittedMigration(t *testing.T) {
	s, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	p := stringOf(s.CreateProject("Projection failure")["id"])
	s.CommitProjectMemory(p, memoryV2Mutation("legacy-rule"))
	path := filepath.Join(memoryProjectionPath(s.Dir, p), "legacy-rule.md")
	outside := filepath.Join(t.TempDir(), "outside.md")
	if err := os.WriteFile(outside, []byte("outside fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, path); err != nil {
		t.Fatal(err)
	}
	if err := s.migrateMemoryV2(); err == nil {
		t.Fatal("unsafe projection cleanup did not fail")
	}
	if integer(s.row("SELECT count(*) AS n FROM projectMemories")["n"]) != 0 || integer(s.row("SELECT count(*) AS n FROM projectMemoryEntriesV2")["n"]) != 1 {
		t.Fatal("committed migration lost canonical data")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := s.migrateMemoryV2(); err != nil {
		t.Fatal(err)
	}
	if b, err := os.ReadFile(outside); err != nil || string(b) != "outside fixture" {
		t.Fatal("cleanup followed outside symlink")
	}
	if _, err := os.Stat(filepath.Join(memoryV2ProjectionPath(s.Dir, p), "legacy-rule.md")); err != nil {
		t.Fatal("recovery did not rebuild V2 file")
	}
}

func TestMemoryV2RestartPreservesQueuedSourcesAndRepairsMissingFiles(t *testing.T) {
	dir := t.TempDir()
	s, err := openStore(dir, true)
	if err != nil {
		t.Fatal(err)
	}
	p := stringOf(s.CreateProject("Restart")["id"])
	s.CommitMemoryV2(p, memoryV2Mutation("restart-rule"))
	session := stringOf(s.CreateSession(p, "Source", nil)["id"])
	settings := s.MemorySettings(p)
	snapshot := testMemorySnapshot(p, session, "queued-source", integer(settings["epoch"]), integer(settings["revision"]))
	snapshot.SchemaVersion = 2
	snapshot = ai.SealMemorySnapshot(snapshot)
	if err := s.EnqueueMemoryTurn(snapshot); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(memoryV2ProjectionPath(s.Dir, p), "restart-rule.md")); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = openStore(dir, true)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if s.ClaimMemoryJob() == nil {
		t.Fatal("startup migration skipped a genuine V2 queued source")
	}
	if _, err := os.Stat(filepath.Join(memoryV2ProjectionPath(s.Dir, p), "restart-rule.md")); err != nil {
		t.Fatal("missing mirror not rebuilt")
	}
}

func TestMemoryV2FutureSchemaIsRejectedBeforeMigration(t *testing.T) {
	dir := t.TempDir()
	s, err := openStore(dir, true)
	if err != nil {
		t.Fatal(err)
	}
	s.update(func() any { s.exec("UPDATE projectMemoryMetaV2 SET schemaVersion=3 WHERE id=1"); return nil })
	s.Close()
	if reopened, err := openStore(dir, true); err == nil {
		reopened.Close()
		t.Fatal("future schema opened")
	}
}

func TestMemoryV2MalformedSchemaReturnsErrorWithoutPanic(t *testing.T) {
	dir := t.TempDir()
	s, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	s.update(func() any { s.exec("CREATE TABLE projectMemoryMetaV2 (broken TEXT)"); return nil })
	s.Close()
	if reopened, err := openStore(dir, true); err == nil {
		reopened.Close()
		t.Fatal("malformed metadata opened")
	}
}
