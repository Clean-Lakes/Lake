package web

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

var memoryKeyPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,63}$`)

const memorySchema = `
CREATE TABLE IF NOT EXISTS projectMemorySettings (
 projectId TEXT PRIMARY KEY REFERENCES projects(id),
 useEnabled INTEGER NOT NULL DEFAULT 1,
 extractionEnabled INTEGER NOT NULL DEFAULT 1,
 epoch INTEGER NOT NULL DEFAULT 0,
 revision INTEGER NOT NULL DEFAULT 0,
 settingsRevision INTEGER NOT NULL DEFAULT 0,
 publishedRevision INTEGER NOT NULL DEFAULT 0,
 updatedAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projectMemories (
 projectId TEXT NOT NULL REFERENCES projects(id),
 key TEXT NOT NULL,
 type TEXT NOT NULL,
 description TEXT NOT NULL,
 body TEXT NOT NULL,
 markdown TEXT NOT NULL,
 revision INTEGER NOT NULL,
 projectRevision INTEGER NOT NULL,
 contentHash TEXT NOT NULL,
 originSessionId TEXT NOT NULL DEFAULT '',
 originTurnId TEXT NOT NULL DEFAULT '',
 lastSourceSessionId TEXT NOT NULL DEFAULT '',
 lastSourceTurnId TEXT NOT NULL DEFAULT '',
 sourceIdsJSON TEXT NOT NULL DEFAULT '[]',
 sourceSummaryJSON TEXT NOT NULL DEFAULT '[]',
 resourceIdsJSON TEXT NOT NULL DEFAULT '[]',
 verification TEXT NOT NULL,
 observedAt TEXT NOT NULL DEFAULT '',
 validUntil TEXT NOT NULL DEFAULT '',
 createdAt TEXT NOT NULL,
 updatedAt TEXT NOT NULL,
 deletedAt TEXT NOT NULL DEFAULT '',
 PRIMARY KEY(projectId,key)
);
CREATE INDEX IF NOT EXISTS idx_project_memories ON projectMemories(projectId,deletedAt,updatedAt);
CREATE TABLE IF NOT EXISTS projectMemoryTurns (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 projectId TEXT NOT NULL REFERENCES projects(id),
 sessionId TEXT NOT NULL,
 turnId TEXT NOT NULL,
 epoch INTEGER NOT NULL,
 knowledgeBaseRevision INTEGER NOT NULL,
 snapshotJSON TEXT NOT NULL,
 snapshotHash TEXT NOT NULL,
 modelRefJSON TEXT NOT NULL,
 outcome TEXT NOT NULL,
 createdAt TEXT NOT NULL,
 processedAt TEXT NOT NULL DEFAULT '',
 UNIQUE(projectId,sessionId,turnId)
);
CREATE TABLE IF NOT EXISTS projectMemoryJobs (
 jobId TEXT PRIMARY KEY,
 turnSequence INTEGER NOT NULL UNIQUE REFERENCES projectMemoryTurns(sequence),
 status TEXT NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0,
 nextAttemptAtMs INTEGER NOT NULL DEFAULT 0,
 leaseOwner TEXT NOT NULL DEFAULT '',
 leaseToken TEXT NOT NULL DEFAULT '',
 leaseUntilMs INTEGER NOT NULL DEFAULT 0,
 baseRevision INTEGER NOT NULL DEFAULT 0,
 lastErrorCode TEXT NOT NULL DEFAULT '',
 usageJSON TEXT NOT NULL DEFAULT '{}',
 createdAt TEXT NOT NULL,
 updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_memory_jobs ON projectMemoryJobs(status,nextAttemptAtMs);
CREATE TABLE IF NOT EXISTS projectMemoryCommits (
 commitId TEXT PRIMARY KEY,
 jobId TEXT UNIQUE,
 projectId TEXT NOT NULL REFERENCES projects(id),
 revision INTEGER NOT NULL,
 mutationKeysJSON TEXT NOT NULL,
 sourceTurnSequence INTEGER,
 createdAt TEXT NOT NULL,
 publishedAt TEXT NOT NULL DEFAULT ''
);
`

func (s *Store) migrateProjectMemory() error {
	_, err := s.db.Exec(memorySchema)
	return err
}

func validMemoryKey(key string) bool {
	return key != "memory" && memoryKeyPattern.MatchString(key)
}

func memoryType(t string) bool {
	switch t {
	case "user", "feedback", "project", "reference":
		return true
	}
	return false
}

type MemoryMutation struct {
	Key              string
	Type             string
	Description      string
	Body             string
	ExpectedRevision int
	RestoreDeleted   bool
	ValidUntil       string
	Verification     string
	OriginSessionID  string
	OriginTurnID     string
	SourceKind       string
	Forget           bool
}

func validateMemoryMutation(m MemoryMutation) {
	if !validMemoryKey(m.Key) {
		fail(400, "Invalid memory key")
	}
	if m.ExpectedRevision < 0 {
		fail(400, "Invalid memory revision")
	}
	if m.Forget {
		return
	}
	if !memoryType(m.Type) || m.Description == "" || utf8.RuneCountInString(m.Description) > 160 || strings.ContainsAny(m.Description, "\r\n") || m.Body == "" || len(m.Body) > 16*1024 || !utf8.ValidString(m.Body) {
		fail(400, "Invalid memory content")
	}
	if m.Verification != "user-stated" && m.Verification != "observed" && m.Verification != "reference" {
		fail(400, "Invalid memory verification")
	}
	if m.ValidUntil != "" {
		if _, err := time.Parse(time.RFC3339Nano, m.ValidUntil); err != nil {
			fail(400, "Invalid memory expiration")
		}
	}
}

func (s *Store) memorySettings(project string) Object {
	s.activeProject(project)
	row := s.row("SELECT * FROM projectMemorySettings WHERE projectId=?", project)
	if row == nil {
		return Object{"projectId": project, "useEnabled": true, "extractionEnabled": true, "epoch": 0, "revision": 0, "settingsRevision": 0, "publishedRevision": 0}
	}
	row["useEnabled"] = integer(row["useEnabled"]) != 0
	row["extractionEnabled"] = integer(row["extractionEnabled"]) != 0
	return row
}

func (s *Store) MemorySettings(project string) Object {
	return s.read(func() any { return s.memorySettings(project) }).(Object)
}

func (s *Store) ensureMemorySettings(project string) {
	s.activeProject(project)
	s.exec("INSERT OR IGNORE INTO projectMemorySettings(projectId,updatedAt) VALUES(?,?)", project, now())
}

func (s *Store) SetMemorySettings(project string, use, extraction bool, expected int) Object {
	return s.update(func() any {
		s.ensureMemorySettings(project)
		settings := s.memorySettings(project)
		if integer(settings["settingsRevision"]) != expected {
			fail(409, "Memory settings changed; refresh and retry")
		}
		epoch := integer(settings["epoch"])
		if settings["useEnabled"] != use || settings["extractionEnabled"] != extraction {
			epoch++
		}
		s.exec("UPDATE projectMemorySettings SET useEnabled=?,extractionEnabled=?,epoch=?,settingsRevision=settingsRevision+1,updatedAt=? WHERE projectId=?", use, extraction, epoch, now(), project)
		if !use || !extraction {
			s.exec("UPDATE projectMemoryJobs SET status='skipped',lastErrorCode='memory_disabled',updatedAt=? WHERE turnSequence IN (SELECT sequence FROM projectMemoryTurns WHERE projectId=?) AND status IN ('queued','retry_wait','running')", now(), project)
		}
		return s.memorySettings(project)
	}).(Object)
}

func memoryExpired(value Object, at time.Time) bool {
	until := stringOf(value["validUntil"])
	if until == "" {
		return false
	}
	t, err := time.Parse(time.RFC3339Nano, until)
	return err != nil || !at.Before(t)
}

func publicMemory(row Object) Object {
	if row == nil {
		return nil
	}
	result := Object{}
	if stringOf(row["deletedAt"]) != "" {
		return Object{"projectId": row["projectId"], "key": row["key"], "revision": row["revision"], "deletedAt": row["deletedAt"]}
	}
	for _, key := range []string{"projectId", "key", "type", "description", "body", "revision", "projectRevision", "originSessionId", "originTurnId", "lastSourceSessionId", "lastSourceTurnId", "verification", "observedAt", "validUntil", "createdAt", "updatedAt", "deletedAt"} {
		result[key] = row[key]
	}
	result["expired"] = memoryExpired(row, time.Now().UTC())
	if raw := stringOf(row["sourceSummaryJSON"]); raw != "" {
		var sources []Object
		if json.Unmarshal([]byte(raw), &sources) == nil {
			result["sources"] = sources
		}
	}
	return result
}

func (s *Store) ListProjectMemories(project, query string, offset, limit int, includeExpired, includeDeleted bool) Object {
	if offset < 0 || limit < 1 || limit > 50 || utf8.RuneCountInString(query) > 160 {
		fail(400, "Invalid memory query")
	}
	return s.read(func() any {
		settings := s.memorySettings(project)
		rows := s.rows("SELECT * FROM projectMemories WHERE projectId=? ORDER BY updatedAt DESC,key", project)
		items := []Object{}
		q := strings.ToLower(strings.TrimSpace(query))
		for _, row := range rows {
			if !includeDeleted && stringOf(row["deletedAt"]) != "" {
				continue
			}
			if !includeExpired && memoryExpired(row, time.Now().UTC()) {
				continue
			}
			if q != "" && !strings.Contains(strings.ToLower(stringOf(row["key"])+" "+stringOf(row["description"])), q) {
				continue
			}
			entry := publicMemory(row)
			delete(entry, "body")
			delete(entry, "sources")
			items = append(items, entry)
		}
		total := len(items)
		if offset >= total {
			items = []Object{}
		} else {
			items = items[offset:min(total, offset+limit)]
		}
		return Object{"settings": settings, "items": items, "total": total, "projectRevision": settings["revision"]}
	}).(Object)
}

func (s *Store) ReadProjectMemory(project, key string, includeDeleted bool) Object {
	if !validMemoryKey(key) {
		fail(400, "Invalid memory key")
	}
	return s.read(func() any {
		s.activeProject(project)
		row := required(s.row("SELECT * FROM projectMemories WHERE projectId=? AND key=?", project, key), "Memory")
		if stringOf(row["deletedAt"]) != "" && !includeDeleted {
			fail(404, "Memory not found")
		}
		return publicMemory(row)
	}).(Object)
}

func (s *Store) CommitProjectMemory(project string, m MemoryMutation) Object {
	validateMemoryMutation(m)
	result := s.update(func() any {
		s.ensureMemorySettings(project)
		settings := s.memorySettings(project)
		old := s.row("SELECT * FROM projectMemories WHERE projectId=? AND key=?", project, m.Key)
		revision := 0
		if old != nil {
			revision = integer(old["revision"])
		}
		if revision != m.ExpectedRevision {
			fail(409, "Memory changed; refresh and retry")
		}
		if m.Forget && (old == nil || stringOf(old["deletedAt"]) != "") {
			fail(404, "Memory not found")
		}
		if !m.Forget && old != nil && stringOf(old["deletedAt"]) != "" && !m.RestoreDeleted {
			fail(409, "Memory was forgotten; explicit restore required")
		}
		if !m.Forget && old == nil && integer(s.row("SELECT count(*) AS count FROM projectMemories WHERE projectId=? AND deletedAt=''", project)["count"]) >= 500 {
			fail(429, "Project memory is full")
		}
		t := now()
		next := integer(settings["revision"]) + 1
		epoch := integer(settings["epoch"]) + 1
		description, body, markdown, deletedAt, kind, verification, validUntil := m.Description, m.Body, "", "", m.Type, m.Verification, m.ValidUntil
		if m.Forget {
			description, body, deletedAt, validUntil = "", "", t, ""
			kind, verification = stringOf(old["type"]), stringOf(old["verification"])
		}
		originSession, originTurn, createdAt := m.OriginSessionID, m.OriginTurnID, t
		if old != nil && stringOf(old["deletedAt"]) == "" {
			originSession, originTurn, createdAt = stringOf(old["originSessionId"]), stringOf(old["originTurnId"]), stringOf(old["createdAt"])
		}
		lastSession, lastTurn := m.OriginSessionID, m.OriginTurnID
		if m.Forget {
			originSession, originTurn, lastSession, lastTurn = "", "", "", ""
		}
		if !m.Forget {
			markdown = renderMemoryMarkdown(m.Key, m.Type, m.Description, m.Body, memoryMarkdownMeta{ProjectID: project, OriginSessionID: originSession, OriginTurnID: originTurn, Revision: revision + 1, UpdatedAt: t, Verification: m.Verification, ValidUntil: m.ValidUntil})
		}
		sourceKind := m.SourceKind
		if sourceKind == "" {
			sourceKind = "manual-ui"
		}
		sources := []Object{{"kind": sourceKind, "sessionId": m.OriginSessionID, "turnId": m.OriginTurnID, "at": t}}
		if !m.Forget && old != nil && stringOf(old["deletedAt"]) == "" {
			var previous []Object
			_ = json.Unmarshal([]byte(stringOf(old["sourceSummaryJSON"])), &previous)
			sources = append(previous, sources...)
			if len(sources) > 8 {
				sources = sources[len(sources)-8:]
			}
		}
		if m.Forget {
			s.eraseStrategyExperiments("jobId IN (SELECT id FROM strategyJobs WHERE accessProjectId=?)", project)
			s.strategyInvalidateJobs("id IN (SELECT jobId FROM strategyExperiments WHERE jobId IN (SELECT id FROM strategyJobs WHERE accessProjectId=?))", project)
			sources = nil
		}
		hash := fmt.Sprintf("%x", sha256.Sum256([]byte(body)))
		s.exec(`INSERT INTO projectMemories(projectId,key,type,description,body,markdown,revision,projectRevision,contentHash,originSessionId,originTurnId,lastSourceSessionId,lastSourceTurnId,sourceSummaryJSON,verification,validUntil,createdAt,updatedAt,deletedAt)
VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(projectId,key) DO UPDATE SET type=excluded.type,description=excluded.description,body=excluded.body,markdown=excluded.markdown,revision=excluded.revision,projectRevision=excluded.projectRevision,contentHash=excluded.contentHash,originSessionId=excluded.originSessionId,originTurnId=excluded.originTurnId,lastSourceSessionId=excluded.lastSourceSessionId,lastSourceTurnId=excluded.lastSourceTurnId,sourceIdsJSON='[]',sourceSummaryJSON=excluded.sourceSummaryJSON,resourceIdsJSON='[]',verification=excluded.verification,observedAt='',validUntil=excluded.validUntil,createdAt=excluded.createdAt,updatedAt=excluded.updatedAt,deletedAt=excluded.deletedAt`,
			project, m.Key, kind, description, body, markdown, revision+1, next, hash, originSession, originTurn, lastSession, lastTurn, jsonText(sources), verification, validUntil, createdAt, t, deletedAt)
		s.exec("UPDATE projectMemorySettings SET revision=?,epoch=?,updatedAt=? WHERE projectId=?", next, epoch, t, project)
		s.exec("UPDATE projectMemoryJobs SET status='skipped',lastErrorCode='memory_changed',updatedAt=? WHERE turnSequence IN (SELECT sequence FROM projectMemoryTurns WHERE projectId=?) AND status IN ('queued','retry_wait','running')", t, project)
		commitID := ident()
		s.exec("INSERT INTO projectMemoryCommits(commitId,projectId,revision,mutationKeysJSON,createdAt) VALUES(?,?,?,?,?)", commitID, project, next, jsonText([]string{m.Key}), t)
		return Object{"commitId": commitID, "projectRevision": next, "revision": revision + 1, "key": m.Key, "deleted": m.Forget}
	}).(Object)
	if err := s.PublishProjectMemory(project); err != nil {
		result["publicationError"] = "Memory saved; file publication pending"
	}
	return result
}

func (s *Store) listMemoryRows(project string) ([]Object, int) {
	s.activeProject(project)
	settings := s.memorySettings(project)
	return s.rows("SELECT * FROM projectMemories WHERE projectId=? AND deletedAt='' ORDER BY key", project), integer(settings["revision"])
}

func memoryIndex(rows []Object) string {
	ordered := append([]Object(nil), rows...)
	sort.SliceStable(ordered, func(i, j int) bool {
		if ordered[i]["type"] != ordered[j]["type"] {
			order := map[string]int{"feedback": 0, "project": 1, "reference": 2, "user": 3}
			return order[stringOf(ordered[i]["type"])] < order[stringOf(ordered[j]["type"])]
		}
		if ordered[i]["updatedAt"] != ordered[j]["updatedAt"] {
			return stringOf(ordered[i]["updatedAt"]) > stringOf(ordered[j]["updatedAt"])
		}
		return stringOf(ordered[i]["key"]) < stringOf(ordered[j]["key"])
	})
	var b strings.Builder
	for _, row := range ordered {
		fmt.Fprintf(&b, "- [%s](%s.md) — %s\n", row["key"], row["key"], row["description"])
	}
	return b.String()
}

func (s *Store) ProjectMemoryIndex(project string) string {
	return s.read(func() any {
		rows, _ := s.listMemoryRows(project)
		active := []Object{}
		for _, row := range rows {
			if !memoryExpired(row, time.Now().UTC()) {
				active = append(active, row)
			}
		}
		index := memoryIndex(active)
		lines := strings.Split(strings.TrimSuffix(index, "\n"), "\n")
		if index == "" {
			return ""
		}
		var bounded strings.Builder
		kept := 0
		for _, line := range lines {
			if kept >= 199 || bounded.Len()+len(line)+1 > 24*1024-100 {
				break
			}
			bounded.WriteString(line)
			bounded.WriteByte('\n')
			kept++
		}
		if kept < len(lines) {
			bounded.WriteString("- [More project memories: use list_project_memories]\n")
		}
		return bounded.String()
	}).(string)
}

// The DB is authoritative; this error only means the human-readable file copy needs repair.
var errMemoryProjection = errors.New("memory projection failed")
