package web

import (
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"

	"github.com/Clean-Lakes/Lake/internal/platform"
)

// Enable only with the complete V2 API, tools, UI and acceptance suite. Tests
// exercise migration directly against an isolated Store; no environment bypass.
const operationalMemoryV2Ready = false

func (s *Store) checkMemoryV2Compatibility() error {
	var name string
	err := s.db.QueryRow("SELECT name FROM sqlite_master WHERE type='table' AND name='projectMemoryMetaV2'").Scan(&name)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("check project memory schema: %w", err)
	}
	var version int
	err = s.db.QueryRow("SELECT schemaVersion FROM projectMemoryMetaV2 WHERE id=1").Scan(&version)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	} // No committed migration marker; recover normally.
	if err != nil {
		return fmt.Errorf("read project memory schema: %w", err)
	}
	if version != 2 {
		return fmt.Errorf("unsupported project memory schema; use a compatible Lake build")
	}
	if !s.memoryV2Wanted {
		return fmt.Errorf("this Home has operational memory V2; use a V2-enabled build or an isolated compatibility copy")
	}
	return nil
}

const memoryV2Schema = `
CREATE TABLE IF NOT EXISTS projectMemoryMetaV2 (
 id INTEGER PRIMARY KEY CHECK(id=1), schemaVersion INTEGER NOT NULL, migratedAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projectMemoryEntriesV2 (
 projectId TEXT NOT NULL REFERENCES projects(id), key TEXT NOT NULL,
 type TEXT NOT NULL, description TEXT NOT NULL, body TEXT NOT NULL,
 revision INTEGER NOT NULL, projectRevision INTEGER NOT NULL, contentHash TEXT NOT NULL,
 knowledgeKind TEXT NOT NULL, scopeKind TEXT NOT NULL, scopeHash TEXT NOT NULL,
 subjectJSON TEXT NOT NULL DEFAULT '{}', claimJSON TEXT NOT NULL DEFAULT '{}', factKey TEXT NOT NULL,
 bindingsJSON TEXT NOT NULL DEFAULT '[]', verification TEXT NOT NULL,
 assertedAt TEXT NOT NULL DEFAULT '', observedAt TEXT NOT NULL DEFAULT '', validUntil TEXT NOT NULL DEFAULT '',
 reviewState TEXT NOT NULL, alwaysReference INTEGER NOT NULL DEFAULT 0,
 originSessionId TEXT NOT NULL DEFAULT '', originTurnId TEXT NOT NULL DEFAULT '',
 createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, deletedAt TEXT NOT NULL DEFAULT '',
 PRIMARY KEY(projectId,key)
);
CREATE INDEX IF NOT EXISTS idx_memory_v2_state ON projectMemoryEntriesV2(projectId,deletedAt,reviewState,knowledgeKind);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_v2_fact ON projectMemoryEntriesV2(projectId,scopeHash,factKey)
 WHERE deletedAt='' AND reviewState='active';
CREATE TABLE IF NOT EXISTS projectMemoryRevisionsV2 (
 projectId TEXT NOT NULL, key TEXT NOT NULL, revision INTEGER NOT NULL,
 snapshotJSON TEXT NOT NULL, changeKind TEXT NOT NULL, changedAt TEXT NOT NULL,
 PRIMARY KEY(projectId,key,revision),
 FOREIGN KEY(projectId,key) REFERENCES projectMemoryEntriesV2(projectId,key)
);
CREATE TABLE IF NOT EXISTS projectMemorySourcesV2 (
 sourceId TEXT PRIMARY KEY, projectId TEXT NOT NULL, key TEXT NOT NULL, entryRevision INTEGER NOT NULL,
 kind TEXT NOT NULL, sessionId TEXT NOT NULL DEFAULT '', turnId TEXT NOT NULL DEFAULT '', messageId TEXT NOT NULL DEFAULT '',
 callId TEXT NOT NULL DEFAULT '', evidenceId TEXT NOT NULL DEFAULT '', resourceId TEXT NOT NULL DEFAULT '',
 resourceGeneration INTEGER NOT NULL DEFAULT 0, observedAt TEXT NOT NULL DEFAULT '', assertedAt TEXT NOT NULL DEFAULT '',
 outcome TEXT NOT NULL DEFAULT '', excerpt TEXT NOT NULL DEFAULT '', sourceHash TEXT NOT NULL, claimSupport TEXT NOT NULL DEFAULT '',
 FOREIGN KEY(projectId,key) REFERENCES projectMemoryEntriesV2(projectId,key)
);
CREATE INDEX IF NOT EXISTS idx_memory_v2_sources ON projectMemorySourcesV2(projectId,key,entryRevision);
CREATE TABLE IF NOT EXISTS resourceMemoryGenerations (
 resourceId TEXT PRIMARY KEY REFERENCES resources(id) ON DELETE CASCADE, generation INTEGER NOT NULL CHECK(generation>=1),
 updatedAt TEXT NOT NULL, reason TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projectMemoryCandidatesV2 (
 candidateId TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id), jobId TEXT NOT NULL DEFAULT '',
 candidateHash TEXT NOT NULL, baseKey TEXT NOT NULL, baseRevision INTEGER NOT NULL,
 proposalJSON TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL,
 createdAt TEXT NOT NULL, expiresAt TEXT NOT NULL,
 UNIQUE(projectId,jobId,candidateHash)
);
CREATE INDEX IF NOT EXISTS idx_memory_v2_candidates ON projectMemoryCandidatesV2(projectId,status,createdAt);
CREATE TABLE IF NOT EXISTS projectMemoryJobAttemptsV2 (
 attemptId TEXT PRIMARY KEY, jobId TEXT NOT NULL, projectId TEXT NOT NULL REFERENCES projects(id),
 startedAt TEXT NOT NULL, finishedAt TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
 inputUsage INTEGER NOT NULL DEFAULT 0, outputUsage INTEGER NOT NULL DEFAULT 0,
 usageKnown INTEGER NOT NULL DEFAULT 0, modelRefHash TEXT NOT NULL, reason TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_memory_v2_attempts ON projectMemoryJobAttemptsV2(projectId,startedAt);
`

func (s *Store) prepareMemoryV2Migration() error {
	if s.row("SELECT name FROM sqlite_master WHERE type='table' AND name='projectMemoryMetaV2'") != nil {
		meta := s.row("SELECT schemaVersion FROM projectMemoryMetaV2 WHERE id=1")
		if integer(meta["schemaVersion"]) > 2 {
			return fmt.Errorf("project memory schema requires a newer Lake version")
		}
		if meta != nil {
			return nil
		}
	}
	if integer(s.row("SELECT count(*) AS n FROM projectMemories")["n"]) == 0 {
		return nil
	}
	backup := filepath.Join(s.Dir, "lake-web.before-memory-v2-"+ident()+".sqlite")
	if _, err := s.db.Exec("VACUUM INTO ?", backup); err != nil {
		return fmt.Errorf("project memory backup failed: %w", err)
	}
	return platform.Chmod(backup, 0600)
}

func (s *Store) migrateMemoryV2() (err error) {
	// Called during startup, before workers; tests call it on their private Home.
	if err = s.prepareMemoryV2Migration(); err != nil {
		return err
	}
	defer func() {
		if p := recover(); p != nil {
			err = fmt.Errorf("project memory migration failed")
		}
	}()
	s.update(func() any {
		s.exec(memoryV2Schema)
		needsPublish := s.row("SELECT id FROM projectMemoryMetaV2 WHERE id=1") == nil || integer(s.row("SELECT count(*) AS n FROM projectMemories")["n"]) > 0
		t := now()
		for _, resource := range s.rows("SELECT id FROM resources") {
			s.exec("INSERT OR IGNORE INTO resourceMemoryGenerations(resourceId,generation,updatedAt,reason) VALUES(?,1,?,'initial')", resource["id"], t)
		}
		for _, old := range s.rows("SELECT * FROM projectMemories ORDER BY projectId,key") {
			project, key := stringOf(old["projectId"]), stringOf(old["key"])
			if !validMemoryKey(key) {
				fail(400, "Invalid legacy memory key")
			}
			current := s.row("SELECT * FROM projectMemoryEntriesV2 WHERE projectId=? AND key=?", project, key)
			if current != nil {
				// A downgrade must never overwrite V2 edits or resurrect a tombstone.
				if stringOf(current["deletedAt"]) == "" && old["body"] != current["body"] && stringOf(old["deletedAt"]) == "" {
					s.insertMemoryCandidate(project, "legacy", key, integer(current["revision"]), old, "legacy_import")
				}
				continue
			}
			entry := Object{"projectId": project, "key": key, "type": old["type"], "description": old["description"], "body": old["body"], "revision": old["revision"], "projectRevision": old["projectRevision"], "contentHash": old["contentHash"], "knowledgeKind": "procedure", "scopeKind": "resources", "scopeHash": "legacy:" + key, "subjectJSON": "{}", "claimJSON": "{}", "factKey": "legacy." + key, "bindingsJSON": "[]", "verification": old["verification"], "assertedAt": "", "observedAt": old["observedAt"], "validUntil": old["validUntil"], "reviewState": "needs_review", "alwaysReference": 0, "originSessionId": old["originSessionId"], "originTurnId": old["originTurnId"], "createdAt": old["createdAt"], "updatedAt": old["updatedAt"], "deletedAt": old["deletedAt"]}
			if stringOf(old["deletedAt"]) != "" {
				entry = memoryV2Tombstone(entry, integer(old["revision"]), integer(old["projectRevision"]), stringOf(old["deletedAt"]))
			}
			s.writeMemoryV2Row(entry)
			if stringOf(entry["deletedAt"]) == "" {
				for _, source := range memoryObjects(old["sourceSummaryJSON"]) {
					s.appendMemoryV2Source(entry, source)
				}
			}
		}
		s.exec("DELETE FROM projectMemories")
		if needsPublish {
			s.exec("UPDATE projectMemorySettings SET publishedRevision=-1")
		}
		s.exec(`UPDATE projectMemoryJobs SET status='skipped',lastErrorCode='migrated_v2',leaseToken='',leaseOwner='',leaseUntilMs=0
 WHERE status IN ('queued','retry_wait','running','budget_wait') AND turnSequence IN
 (SELECT sequence FROM projectMemoryTurns WHERE CASE WHEN json_valid(snapshotJSON) THEN COALESCE(json_extract(snapshotJSON,'$.schemaVersion'),1) ELSE 1 END<>2)`)
		s.exec("INSERT OR IGNORE INTO projectMemoryMetaV2(id,schemaVersion,migratedAt) VALUES(1,2,?)", t)
		return nil
	})
	if err = s.cleanLegacyMemoryProjection(); err != nil {
		return err
	}
	s.memoryV2 = true
	return s.ReconcileProjectMemoryFiles()
}
