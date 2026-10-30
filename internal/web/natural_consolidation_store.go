package web

import (
	"encoding/json"
	"strings"
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

const naturalConsolidationPolicy = 1

func naturalCoverageKey(s ai.MemoryTurnSnapshot) string {
	consent := ai.NaturalMemoryConsent{}
	if s.Natural != nil {
		consent = *s.Natural
	}
	if !consent.GlobalEnabled {
		consent.GlobalEpoch = 0
	}
	if !consent.ProjectEnabled {
		consent.ProjectEpoch = 0
	}
	return memoryHash(jsonText(Object{"project": s.ProjectID, "session": s.SessionID, "message": s.SourceMessageID, "text": memoryHash(s.UserText), "evidence": s.Evidence, "targets": s.TargetBindings, "natural": consent, "legacy": s.LegacyExtraction, "epoch": s.Epoch, "consolidationPolicy": naturalConsolidationPolicy}))
}

func (s *Store) naturalSourceAfterUserEdit(id, created string) bool {
	row := s.row("SELECT createdAt FROM naturalPreferenceChanges WHERE entryId=? AND kind IN ('undo','forget') ORDER BY rowid DESC LIMIT 1", id)
	return row == nil || !naturalBefore(created, stringOf(row["createdAt"]))
}
func (s *Store) naturalCloneSupports(id string, from, to int) {
	s.exec("INSERT OR IGNORE INTO naturalPreferenceSupports SELECT entryId,?,sourceProject,sourceSession,sourceMessage,sourceHash,quoteRevision FROM naturalPreferenceSupports WHERE entryId=? AND revision=?", to, id, from)
}
func (s *Store) naturalAddSupport(id string, revision int, project, session, message, hash string, quoteRevision int) {
	s.exec("INSERT OR IGNORE INTO naturalPreferenceSupports VALUES(?,?,?,?,?,?,?)", id, revision, project, session, message, hash, quoteRevision)
}
func (s *Store) naturalSupportViews(scope, id string, revision int) []Object {
	out := []Object{}
	for _, r := range s.rows("SELECT * FROM naturalPreferenceSupports WHERE entryId=? AND revision=? ORDER BY sourceMessage LIMIT 50", id, revision) {
		available := s.naturalRevisionAvailable(r)
		view := Object{"available": available, "private": scope == "user"}
		if scope != "user" {
			view["sessionId"] = r["sourceSession"]
			view["messageId"] = r["sourceMessage"]
			view["sourceHash"] = r["sourceHash"]
		}
		out = append(out, view)
	}
	return out
}
func (s *Store) naturalPendingConflict(id string, revision int) bool {
	for _, r := range s.rows("SELECT * FROM naturalPreferenceConflicts WHERE entryId=? AND expectedRevision=? AND status='pending' LIMIT 50", id, revision) {
		if s.naturalRevisionAvailable(r) {
			return true
		}
	}
	return false
}
func (s *Store) naturalRecordConflict(snap ai.MemoryTurnSnapshot, r NaturalPreferenceResult) bool {
	if !s.naturalSnapshotValid(snap) || validateNaturalPreferenceResult(snap.UserText, r) != nil {
		fail(409, "Conflict source changed")
	}
	scope := "project:" + snap.ProjectID
	if r.Scope == "user" {
		if !s.naturalGlobalTextSafe(snap.ProjectID, r.Quote, r.Topic) {
			fail(400, "Private metadata cannot be a global conflict")
		}
		scope = "user"
		if !snap.Natural.GlobalEnabled {
			fail(409, "Global consent unavailable")
		}
	} else if !snap.Natural.ProjectEnabled {
		fail(409, "Project consent unavailable")
	}
	entry := s.row("SELECT * FROM naturalPreferenceEntries WHERE scopeKey=? AND topic=?", scope, r.Topic)
	if entry == nil || entry["state"] != "active" || integer(entry["revision"]) != r.ExpectedRevision {
		fail(409, "Conflict target changed")
	}
	source := s.row("SELECT createdAt FROM messages WHERE id=?", snap.SourceMessageID)
	if !s.naturalSourceAfterUserEdit(stringOf(entry["id"]), stringOf(source["createdAt"])) {
		fail(409, "Conflict source is stale")
	}
	if s.row("SELECT id FROM naturalPreferenceConflicts WHERE entryId=? AND sourceMessage=? AND sourceHash=?", entry["id"], snap.SourceMessageID, memoryHash(snap.UserText)) != nil {
		return false
	}
	id := ident()
	s.exec("INSERT INTO naturalPreferenceConflicts(id,scopeKey,entryId,expectedRevision,sourceProject,sourceSession,sourceMessage,sourceHash,quoteHash,status,createdAt) VALUES(?,?,?,?,?,?,?,?,?,'pending',?)", id, scope, entry["id"], r.ExpectedRevision, snap.ProjectID, snap.SessionID, snap.SourceMessageID, memoryHash(snap.UserText), memoryHash(r.Quote), now())
	s.exec("INSERT INTO naturalPreferenceConflictContent VALUES(?,?)", id, r.Quote)
	s.event(snap.SessionID, "message")
	return true
}
func (s *Store) NaturalConflicts(ctx StrategyContext, after string, limit int) (Object, error) {
	return strategyCall(s, false, func() Object {
		scope := s.strategyAuthorize(ctx, naturalScope(ctx))
		if limit < 1 || limit > 50 {
			naturalFail(400, "invalid_page")
		}
		items := s.rows("SELECT id,entryId,expectedRevision,status,sourceProject,sourceSession,sourceMessage,sourceHash,createdAt FROM naturalPreferenceConflicts WHERE scopeKey=? AND id>? ORDER BY id LIMIT ?", scope, after, limit)
		for _, r := range items {
			available := s.naturalRevisionAvailable(r)
			content := s.row("SELECT body FROM naturalPreferenceConflictContent WHERE id=?", r["id"])
			body := ""
			if available && content != nil {
				body = stringOf(content["body"])
			}
			r["body"] = body
			entry := s.row("SELECT revision,state FROM naturalPreferenceEntries WHERE id=?", r["entryId"])
			r["currentRevision"] = entry["revision"]
			r["stale"] = integer(entry["revision"]) != integer(r["expectedRevision"]) || entry["state"] != "active"
			r["source"] = Object{"available": available, "private": scope == "user"}
			if scope != "user" && available {
				object(r["source"])["sessionId"] = r["sourceSession"]
				object(r["source"])["messageId"] = r["sourceMessage"]
			}
			for _, key := range []string{"sourceProject", "sourceSession", "sourceMessage", "sourceHash"} {
				delete(r, key)
			}
		}
		next := ""
		if len(items) == limit {
			next = stringOf(items[len(items)-1]["id"])
		}
		return Object{"items": items, "nextCursor": next}
	})
}
func (s *Store) RejectNaturalConflict(ctx StrategyContext, id, key string, expected int) (Object, error) {
	return strategyCall(s, true, func() Object {
		scope := s.strategyAuthorize(ctx, naturalScope(ctx))
		c := s.row("SELECT * FROM naturalPreferenceConflicts WHERE id=? AND scopeKey=?", id, scope)
		if c == nil {
			naturalFail(404, "conflict_unavailable")
		}
		replay, digest := s.naturalReceipt(scope, key, Object{"operation": "reject_conflict", "id": id, "revision": expected})
		if replay != nil {
			return replay
		}
		entry := s.row("SELECT revision FROM naturalPreferenceEntries WHERE id=?", c["entryId"])
		if integer(entry["revision"]) != expected || c["status"] != "pending" {
			naturalFail(409, "conflict_changed")
		}
		s.exec("UPDATE naturalPreferenceConflicts SET status='rejected',resolvedAt=? WHERE id=?", now(), id)
		s.exec("DELETE FROM naturalPreferenceConflictContent WHERE id=?", id)
		s.exec("INSERT OR IGNORE INTO naturalPreferenceSuppressions VALUES(?,?,?)", c["sourceMessage"], c["sourceHash"], now())
		out := Object{"id": id, "status": "rejected"}
		s.naturalSaveReceipt(scope, key, digest, out)
		if s.row("SELECT id FROM sessions WHERE id=?", c["sourceSession"]) != nil {
			s.event(stringOf(c["sourceSession"]), "message")
		}
		return out
	})
}
func (s *Store) naturalForgetConsolidation(id string) {
	for _, r := range s.rows("SELECT * FROM naturalPreferenceSupports WHERE entryId=?", id) {
		s.exec("INSERT OR IGNORE INTO naturalPreferenceSuppressions VALUES(?,?,?)", r["sourceMessage"], r["sourceHash"], now())
	}
	for _, r := range s.rows("SELECT * FROM naturalPreferenceConflicts WHERE entryId=?", id) {
		s.exec("INSERT OR IGNORE INTO naturalPreferenceSuppressions VALUES(?,?,?)", r["sourceMessage"], r["sourceHash"], now())
	}
	s.exec("DELETE FROM naturalPreferenceConflictContent WHERE id IN (SELECT id FROM naturalPreferenceConflicts WHERE entryId=?)", id)
	s.exec("UPDATE naturalPreferenceConflicts SET status='withdrawn',resolvedAt=? WHERE entryId=? AND status='pending'", now(), id)
	s.exec("UPDATE naturalMemoryCoverage SET stage='withdrawn',reason='forgotten',updatedAt=? WHERE messageId IN (SELECT sourceMessage FROM naturalPreferenceSupports WHERE entryId=? UNION SELECT sourceMessage FROM naturalPreferenceConflicts WHERE entryId=?)", now(), id, id)
}
func (s *Store) naturalWithdrawConsolidation(session string) {
	for _, r := range s.rows("SELECT messageId sourceMessage,sourceHash FROM naturalMemoryCoverage WHERE sessionId=? UNION SELECT sourceMessage,sourceHash FROM naturalPreferenceConflicts WHERE sourceSession=?", session, session) {
		s.exec("INSERT OR IGNORE INTO naturalPreferenceSuppressions VALUES(?,?,?)", r["sourceMessage"], r["sourceHash"], now())
	}
	s.exec("DELETE FROM naturalPreferenceConflictContent WHERE id IN (SELECT id FROM naturalPreferenceConflicts WHERE sourceSession=?)", session)
	s.exec("UPDATE naturalPreferenceConflicts SET status='withdrawn',resolvedAt=? WHERE sourceSession=? AND status='pending'", now(), session)
	s.exec("UPDATE naturalMemoryCoverage SET stage='withdrawn',reason='source_deleted',updatedAt=? WHERE sessionId=?", now(), session)
}
func (s *Store) wakeNaturalDeferred() {
	s.exec("UPDATE projectMemoryJobs SET status='queued',lastErrorCode='',updatedAt=? WHERE status='budget_wait' AND nextAttemptAtMs<=? AND turnSequence IN (SELECT turnSequence FROM naturalMemoryCoverage WHERE stage='deferred')", now(), time.Now().UnixMilli())
	// Queue pressure never advances processed coverage. Admit a small bounded tail.
	rows := s.rows("SELECT j.jobId,t.projectId,t.sequence FROM projectMemoryJobs j JOIN projectMemoryTurns t ON t.sequence=j.turnSequence JOIN naturalMemoryCoverage c ON c.turnSequence=t.sequence WHERE c.stage='deferred' AND c.reason='queue_limit' AND t.snapshotJSON<>'' ORDER BY t.sequence LIMIT 8")
	for _, r := range rows {
		if integer(s.row("SELECT count(*) n FROM projectMemoryJobs j JOIN projectMemoryTurns t ON t.sequence=j.turnSequence WHERE t.projectId=? AND j.status IN ('queued','running','retry_wait')", r["projectId"])["n"]) < 100 {
			s.exec("UPDATE projectMemoryJobs SET status='queued',lastErrorCode='',nextAttemptAtMs=?,updatedAt=? WHERE jobId=?", time.Now().UnixMilli(), now(), r["jobId"])
			s.exec("UPDATE naturalMemoryCoverage SET stage='captured',reason='',updatedAt=? WHERE turnSequence=?", now(), r["sequence"])
		}
	}
}
func (s *Store) NaturalConsolidationStatus(ctx StrategyContext) (Object, error) {
	return strategyCall(s, false, func() Object {
		s.strategyAuthorize(ctx, naturalScope(ctx))
		where, args := "", []any{}
		if ctx.ProjectID != "" {
			where = " WHERE c.projectId=?"
			args = append(args, ctx.ProjectID)
		}
		// Global status is aggregate counts only, never source/project identities.
		counts := Object{"captured": 0, "processed": 0, "deferred": 0, "withdrawn": 0}
		for _, r := range s.rows("SELECT c.stage,count(*) n FROM naturalMemoryCoverage c"+where+" GROUP BY c.stage", args...) {
			counts[stringOf(r["stage"])] = r["n"]
		}
		counts["conflicts"] = s.row("SELECT count(*) n FROM naturalPreferenceConflicts WHERE scopeKey=? AND status='pending'", strategyScopeKey(naturalScope(ctx)))["n"]
		return counts
	})
}
func naturalDecodeSnapshot(job Object) (ai.MemoryTurnSnapshot, bool) {
	var snap ai.MemoryTurnSnapshot
	err := json.Unmarshal([]byte(stringOf(job["snapshotJSON"])), &snap)
	return snap, err == nil && ai.ValidMemorySnapshot(snap) && snap.Natural != nil
}

func (s *Store) naturalGlobalTextSafe(project, body, topic string) bool {
	names := s.rows("SELECT name FROM projects WHERE id=? UNION ALL SELECT name FROM resources WHERE projectId=?", project, project)
	for _, r := range names {
		name := stringOf(r["name"])
		if len([]rune(name)) >= 3 && (strings.Contains(strings.ToLower(body), strings.ToLower(name)) || strings.Contains(strings.ToLower(topic), strings.ToLower(name))) {
			return false
		}
	}
	return true
}
