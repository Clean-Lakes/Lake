package web

import (
	"strings"
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func (s *Store) NaturalConsent(project string) *ai.NaturalMemoryConsent {
	return s.read(func() any { return s.naturalConsent(project) }).(*ai.NaturalMemoryConsent)
}
func (s *Store) naturalConsent(project string) *ai.NaturalMemoryConsent {
	if s.memoryV2 {
		return (*ai.NaturalMemoryConsent)(nil)
	}
	g := s.naturalSettings(StrategyContext{})
	p := s.naturalSettings(StrategyContext{ProjectID: project})
	return &ai.NaturalMemoryConsent{GlobalEnabled: boolOf(g["autoEnabled"]), ProjectEnabled: boolOf(p["autoEnabled"]), GlobalEpoch: integer(g["epoch"]), ProjectEpoch: integer(p["epoch"]), PolicyVersion: naturalMemoryPolicyVersion}
}
func (s *Store) naturalSnapshotValid(snap ai.MemoryTurnSnapshot) bool {
	if s.row("SELECT id FROM projects WHERE id=? AND "+activeProjectsSQL, snap.ProjectID) == nil {
		return false
	}
	c := snap.Natural
	if snap.LegacyExtraction {
		legacy := s.memorySettings(snap.ProjectID)
		if legacy["useEnabled"] != true || legacy["extractionEnabled"] != true || integer(legacy["epoch"]) != snap.Epoch {
			return false
		}
	}
	if c == nil || c.PolicyVersion != naturalMemoryPolicyVersion || snap.SourceMessageID == "" || len(snap.UserText) > 64*1024 {
		return false
	}
	current := s.naturalConsent(snap.ProjectID)
	if current == nil || c.GlobalEnabled && (!current.GlobalEnabled || c.GlobalEpoch != current.GlobalEpoch) || c.ProjectEnabled && (!current.ProjectEnabled || c.ProjectEpoch != current.ProjectEpoch) {
		return false
	}
	if !c.GlobalEnabled && !c.ProjectEnabled {
		return false
	}
	row := s.row("SELECT m.text,m.createdAt FROM messages m JOIN sessions x ON x.id=m.sessionId JOIN projects ON projects.id=x.projectId WHERE m.id=? AND m.sessionId=? AND m.role='user' AND x.projectId=? AND "+activeProjectsSQL, snap.SourceMessageID, snap.SessionID, snap.ProjectID)
	for scope, enabled := range map[string]bool{"user": c.GlobalEnabled, "project:" + snap.ProjectID: c.ProjectEnabled} {
		if enabled {
			since := s.row("SELECT enabledAt FROM naturalPreferenceConsent WHERE scopeKey=?", scope)
			if since == nil || naturalBefore(stringOf(row["createdAt"]), stringOf(since["enabledAt"])) {
				return false
			}
		}
	}
	if row == nil || row["text"] != snap.UserText {
		return false
	} // redacted/truncated inputs are never new authority.
	if s.row("SELECT 1 FROM naturalPreferenceSuppressions WHERE sourceMessage=? AND sourceHash=?", snap.SourceMessageID, memoryHash(snap.UserText)) != nil {
		return false
	}
	return true
}
func (s *Store) naturalRevisionAvailable(row Object) bool {
	if row == nil {
		return false
	}
	source := s.row("SELECT m.text FROM messages m JOIN sessions x ON x.id=m.sessionId JOIN projects ON projects.id=x.projectId WHERE m.id=? AND m.sessionId=? AND m.role='user' AND x.projectId=? AND "+activeProjectsSQL, row["sourceMessage"], row["sourceSession"], row["sourceProject"])
	return source != nil && memoryHash(stringOf(source["text"])) == row["sourceHash"]
}
func (s *Store) naturalPreferenceView(scope, id string, revision int) Object {
	e := s.row("SELECT * FROM naturalPreferenceEntries WHERE id=? AND scopeKey=?", id, scope)
	if e == nil {
		naturalFail(404, "entry_unavailable")
	}
	if revision == 0 {
		revision = integer(e["revision"])
	}
	r := s.row("SELECT * FROM naturalPreferenceRevisions WHERE entryId=? AND revision=?", id, revision)
	if r == nil {
		naturalFail(404, "revision_unavailable")
	}
	content := s.row("SELECT body FROM naturalPreferenceContent WHERE entryId=? AND revision=?", id, revision)
	body, state := "", stringOf(e["state"])
	if content != nil && state != "forgotten" && s.naturalRevisionAvailable(r) {
		body = stringOf(content["body"])
	} else if state != "forgotten" && state != "undone" {
		state = "unavailable"
	}
	sources := s.naturalSupportViews(scope, id, revision)
	if state == "active" && s.naturalPendingConflict(id, integer(e["revision"])) {
		state = "conflict"
	}
	source := Object{"available": body != "", "private": scope == "user"}
	if scope != "user" && body != "" {
		source["sessionId"] = r["sourceSession"]
		source["messageId"] = r["sourceMessage"]
		source["sourceHash"] = r["sourceHash"]
	}
	return Object{"id": id, "topic": e["topic"], "revision": e["revision"], "contentRevision": revision, "parentRevision": r["parentRevision"], "scope": scope, "body": body, "state": state, "source": source, "sources": sources, "createdAt": r["createdAt"], "updatedAt": e["updatedAt"]}
}
func (s *Store) NaturalFormedPreferences(ctx StrategyContext, after string, limit int) (Object, error) {
	return strategyCall(s, false, func() Object {
		scope := s.strategyAuthorize(ctx, naturalScope(ctx))
		if limit < 1 || limit > 50 {
			naturalFail(400, "invalid_page")
		}
		items := []Object{}
		for _, row := range s.rows("SELECT id FROM naturalPreferenceEntries WHERE scopeKey=? AND id>? ORDER BY id LIMIT ?", scope, after, limit) {
			items = append(items, s.naturalPreferenceView(scope, stringOf(row["id"]), 0))
		}
		next := ""
		if len(items) == limit {
			next = stringOf(items[len(items)-1]["id"])
		}
		return Object{"items": items, "nextCursor": next}
	})
}
func (s *Store) ReadNaturalFormedPreference(ctx StrategyContext, id string, revision int) (Object, error) {
	return strategyCall(s, false, func() Object {
		return s.naturalPreferenceView(s.strategyAuthorize(ctx, naturalScope(ctx)), id, revision)
	})
}
func (s *Store) NaturalPreferenceChanges(ctx StrategyContext, after string, limit int) (Object, error) {
	return strategyCall(s, false, func() Object {
		scope := s.strategyAuthorize(ctx, naturalScope(ctx))
		if limit < 1 || limit > 50 {
			naturalFail(400, "invalid_page")
		}
		items := s.rows("SELECT id,entryId,beforeRevision,afterRevision,kind,createdAt,undoneBy FROM naturalPreferenceChanges WHERE scopeKey=? AND id>? ORDER BY id LIMIT ?", scope, after, limit)
		for _, item := range items {
			if relation := s.row("SELECT relation FROM naturalMemoryRelations WHERE changeId=?", item["id"]); relation != nil && relation["relation"] == "equivalent" {
				item["kind"] = "merge"
			}
		}
		next := ""
		if len(items) == limit {
			next = stringOf(items[len(items)-1]["id"])
		}
		return Object{"items": items, "nextCursor": next}
	})
}

// This is part of the existing project-memory job transaction, not a competing learner.
func (s *Store) commitNaturalPreference(job Object, snap ai.MemoryTurnSnapshot, result NaturalPreferenceResult) bool {
	if !s.naturalSnapshotValid(snap) {
		fail(409, "Natural preference source or consent changed")
	}
	if result.Decision != "save" {
		return false
	}
	if err := validateNaturalPreferenceResult(snap.UserText, result); err != nil {
		fail(400, "Invalid natural preference source")
	}
	scope := "project:" + snap.ProjectID
	if result.Scope == "user" {
		if !s.naturalGlobalTextSafe(snap.ProjectID, result.Quote, result.Topic) {
			fail(400, "Global preference includes private metadata")
		}
		project := s.row("SELECT name FROM projects WHERE id=?", snap.ProjectID)
		if name := stringOf(project["name"]); len([]rune(name)) >= 3 && strings.Contains(result.Quote, name) {
			fail(400, "Global preference includes private project metadata")
		}
		for _, resource := range s.rows("SELECT name FROM resources WHERE projectId=?", snap.ProjectID) {
			if name := stringOf(resource["name"]); len([]rune(name)) >= 3 && strings.Contains(result.Quote, name) {
				fail(400, "Global preference includes private resource metadata")
			}
		}
		scope = "user"
		if !snap.Natural.GlobalEnabled {
			fail(409, "Global automatic memory disabled")
		}
	} else if !snap.Natural.ProjectEnabled {
		fail(409, "Project automatic memory disabled")
	}
	// Ensure only host-resolved scopes are persisted.
	ctx := StrategyContext{ProjectID: snap.ProjectID}
	target := naturalScope(ctx)
	if scope == "user" {
		ctx = StrategyContext{}
		target = naturalScope(ctx)
	}
	s.strategyEnsureScope(ctx, target)
	old := s.row("SELECT * FROM naturalPreferenceEntries WHERE scopeKey=? AND topic=?", scope, result.Topic)
	before := 0
	undoBase := 0
	id := ident()
	kind := "save"
	if old != nil {
		id = stringOf(old["id"])
		before = integer(old["revision"])
		source := s.row("SELECT createdAt FROM messages WHERE id=?", snap.SourceMessageID)
		if !s.naturalSourceAfterUserEdit(id, stringOf(source["createdAt"])) {
			fail(409, "Preference changed after source message")
		}
		priorSource := s.row("SELECT m.createdAt FROM naturalPreferenceRevisions r JOIN messages m ON m.id=r.sourceMessage WHERE r.entryId=? AND r.revision=?", id, before)
		if priorSource != nil && naturalBefore(stringOf(source["createdAt"]), stringOf(priorSource["createdAt"])) {
			fail(409, "Preference source is older")
		}
		if old["state"] != "active" {
			if result.Replacement || result.ExpectedRevision != 0 {
				fail(409, "Withdrawn preference needs a new source")
			}
		} else {
			undoBase = before
			prior := s.naturalPreferenceView(scope, id, 0)
			if prior["body"] == result.Quote && result.Relation != "equivalent" {
				return false
			}
			if prior["state"] != "active" || (!result.Replacement && result.Relation != "equivalent") || result.ExpectedRevision != before {
				fail(409, "Preference replacement requires an exact current version")
			}
			kind = "replace"
		}
	} else if result.ExpectedRevision != 0 || result.Replacement {
		fail(409, "Preference replacement target changed")
	}
	if s.row("SELECT 1 FROM naturalPreferenceRevisions r JOIN naturalPreferenceEntries e ON e.id=r.entryId WHERE e.scopeKey=? AND r.sourceMessage=? AND r.sourceHash=?", scope, snap.SourceMessageID, memoryHash(snap.UserText)) != nil {
		return false
	}
	if before == 0 && integer(s.row("SELECT count(*) AS n FROM naturalPreferenceEntries WHERE scopeKey=? AND state<>'forgotten'", scope)["n"]) >= 500 {
		fail(429, "Preference storage full")
	}
	if result.Relation == "equivalent" && integer(s.row("SELECT count(*) n FROM naturalPreferenceSupports WHERE entryId=? AND revision=?", id, before)["n"]) >= 50 {
		fail(429, "Preference support limit; source remains uncovered")
	}
	s.exec("INSERT INTO naturalPreferenceEntries VALUES(?,?,?,?,'active',?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,state='active',updatedAt=excluded.updatedAt", id, scope, result.Topic, before+1, now())
	s.exec("INSERT INTO naturalPreferenceRevisions VALUES(?,?,?,?,?,?,?,?,?)", id, before+1, before, snap.ProjectID, snap.SessionID, snap.SourceMessageID, memoryHash(snap.UserText), memoryHash(result.Quote), now())
	s.exec("INSERT INTO naturalPreferenceContent VALUES(?,?,?)", id, before+1, result.Quote)
	if result.Relation == "equivalent" {
		s.naturalCloneSupports(id, before, before+1)
	}
	s.naturalAddSupport(id, before+1, snap.ProjectID, snap.SessionID, snap.SourceMessageID, memoryHash(snap.UserText), before+1)
	s.exec("INSERT INTO naturalPreferenceChanges(id,scopeKey,entryId,jobId,sessionId,sourceMessage,beforeRevision,afterRevision,kind,createdAt) VALUES(?,?,?,?,?,?,?,?,?,?)", ident(), scope, id, job["jobId"], snap.SessionID, snap.SourceMessageID, undoBase, before+1, kind, now())
	s.event(snap.SessionID, "message")
	return true
}
func (s *Store) UndoNaturalPreference(ctx StrategyContext, change, key string, expected int) (Object, error) {
	return strategyCall(s, true, func() Object {
		scope := s.strategyAuthorize(ctx, naturalScope(ctx))
		c := s.row("SELECT * FROM naturalPreferenceChanges WHERE id=? AND scopeKey=?", change, scope)
		if c == nil {
			naturalFail(404, "change_unavailable")
		}
		replay, digest := s.naturalReceipt(scope, key, Object{"operation": "undo_preference", "change": change, "revision": expected})
		if replay != nil {
			return replay
		}
		id := stringOf(c["entryId"])
		entry := s.row("SELECT * FROM naturalPreferenceEntries WHERE id=?", id)
		if c["undoneBy"] != "" || (c["kind"] != "save" && c["kind"] != "replace") || integer(entry["revision"]) != expected || integer(c["afterRevision"]) != expected || entry["state"] != "active" {
			naturalFail(409, "undo_conflict")
		}
		latest := s.row("SELECT * FROM naturalPreferenceRevisions WHERE entryId=? AND revision=?", id, expected)
		if !s.naturalRevisionAvailable(latest) {
			naturalFail(409, "source_unavailable")
		}
		before := integer(c["beforeRevision"])
		body, state := "", "undone"
		source := latest
		if before > 0 {
			source = s.row("SELECT * FROM naturalPreferenceRevisions WHERE entryId=? AND revision=?", id, before)
			if !s.naturalRevisionAvailable(source) {
				naturalFail(409, "undo_source_unavailable")
			}
			content := s.row("SELECT body FROM naturalPreferenceContent WHERE entryId=? AND revision=?", id, before)
			if content == nil {
				naturalFail(409, "undo_source_unavailable")
			}
			body = stringOf(content["body"])
			state = "active"
		}
		s.exec("INSERT OR IGNORE INTO naturalPreferenceSuppressions VALUES(?,?,?)", latest["sourceMessage"], latest["sourceHash"], now())
		s.exec("UPDATE naturalPreferenceEntries SET revision=revision+1,state=?,updatedAt=? WHERE id=?", state, now(), id)
		s.exec("INSERT INTO naturalPreferenceRevisions VALUES(?,?,?,?,?,?,?,?,?)", id, expected+1, before, source["sourceProject"], source["sourceSession"], source["sourceMessage"], source["sourceHash"], memoryHash(body), now())
		if body != "" {
			s.naturalCloneSupports(id, before, expected+1)
			s.exec("INSERT INTO naturalPreferenceContent VALUES(?,?,?)", id, expected+1, body)
		}
		undo := ident()
		s.exec("INSERT INTO naturalPreferenceChanges(id,scopeKey,entryId,sessionId,sourceMessage,beforeRevision,afterRevision,kind,createdAt) VALUES(?,?,?,?,?,?,?,'undo',?)", undo, scope, id, c["sessionId"], c["sourceMessage"], expected, expected+1, now())
		s.exec("UPDATE naturalPreferenceChanges SET undoneBy=? WHERE id=?", undo, change)
		result := Object{"id": id, "revision": expected + 1, "changeId": undo}
		s.naturalSaveReceipt(scope, key, digest, result)
		s.event(stringOf(c["sessionId"]), "message")
		return result
	})
}
func (s *Store) ForgetNaturalPreference(ctx StrategyContext, id, key string, expected int) (Object, error) {
	return strategyCall(s, true, func() Object {
		scope := s.strategyAuthorize(ctx, naturalScope(ctx))
		entry := s.row("SELECT * FROM naturalPreferenceEntries WHERE id=? AND scopeKey=?", id, scope)
		if entry == nil {
			naturalFail(404, "entry_unavailable")
		}
		replay, digest := s.naturalReceipt(scope, key, Object{"operation": "forget_preference", "id": id, "revision": expected})
		if replay != nil {
			return replay
		}
		if integer(entry["revision"]) != expected {
			naturalFail(409, "revision_conflict")
		}
		for _, r := range s.rows("SELECT * FROM naturalPreferenceRevisions WHERE entryId=?", id) {
			s.exec("INSERT OR IGNORE INTO naturalPreferenceSuppressions VALUES(?,?,?)", r["sourceMessage"], r["sourceHash"], now())
		}
		latest := s.row("SELECT * FROM naturalPreferenceRevisions WHERE entryId=? AND revision=?", id, expected)
		s.exec("INSERT INTO naturalPreferenceRevisions VALUES(?,?,?,?,?,?,?,?,?)", id, expected+1, expected, latest["sourceProject"], latest["sourceSession"], latest["sourceMessage"], latest["sourceHash"], memoryHash(""), now())
		s.naturalForgetConsolidation(id)
		s.exec("DELETE FROM naturalPreferenceContent WHERE entryId=?", id)
		s.exec("UPDATE naturalPreferenceEntries SET revision=revision+1,state='forgotten',updatedAt=? WHERE id=?", now(), id)
		s.exec("UPDATE projectMemoryJobs SET status='skipped',leaseToken='',lastErrorCode='preference_forgotten',updatedAt=? WHERE status IN ('queued','retry_wait','running') AND turnSequence IN (SELECT sequence FROM projectMemoryTurns WHERE json_valid(snapshotJSON) AND json_extract(snapshotJSON,'$.sourceMessageId') IN (SELECT sourceMessage FROM naturalPreferenceRevisions WHERE entryId=?))", now(), id)
		s.exec("UPDATE projectMemoryTurns SET snapshotJSON='' WHERE json_valid(snapshotJSON) AND json_extract(snapshotJSON,'$.sourceMessageId') IN (SELECT sourceMessage FROM naturalPreferenceRevisions WHERE entryId=?)", id)
		change := ident()
		s.exec("INSERT INTO naturalPreferenceChanges(id,scopeKey,entryId,sessionId,sourceMessage,beforeRevision,afterRevision,kind,createdAt) VALUES(?,?,?,?,?,?,?,'forget',?)", change, scope, id, latest["sourceSession"], latest["sourceMessage"], expected, expected+1, now())
		result := Object{"id": id, "revision": expected + 1, "changeId": change}
		s.naturalSaveReceipt(scope, key, digest, result)
		if s.row("SELECT id FROM sessions WHERE id=?", latest["sourceSession"]) != nil {
			s.event(stringOf(latest["sourceSession"]), "message")
		}
		return result
	})
}
func (s *Store) naturalEraseSession(session string) {
	s.naturalWithdrawConsolidation(session)
	for _, r := range s.rows("SELECT sourceMessage,sourceHash FROM naturalPreferenceRevisions WHERE sourceSession=?", session) {
		s.exec("INSERT OR IGNORE INTO naturalPreferenceSuppressions VALUES(?,?,?)", r["sourceMessage"], r["sourceHash"], now())
	}
	s.exec("DELETE FROM naturalPreferenceContent WHERE (entryId,revision) IN (SELECT entryId,revision FROM naturalPreferenceRevisions WHERE sourceSession=?)", session)
	s.exec("UPDATE projectMemoryTurns SET snapshotJSON='',outcome='skipped',processedAt=? WHERE sessionId=?", now(), session)
	s.exec("UPDATE projectMemoryJobs SET status='skipped',leaseToken='',lastErrorCode='source_deleted',updatedAt=? WHERE turnSequence IN (SELECT sequence FROM projectMemoryTurns WHERE sessionId=?)", now(), session)
}
func (s *Store) naturalSessionNotices(session string) []Object {
	changes := s.rows("SELECT id,scopeKey,entryId,afterRevision,kind,undoneBy FROM naturalPreferenceChanges WHERE sessionId=? AND kind IN ('save','replace') AND id NOT IN (SELECT changeId FROM naturalPreferenceNoticeAcks) ORDER BY rowid DESC LIMIT 20", session)
	result := []Object{}
	for _, c := range changes {
		view := s.naturalPreferenceView(stringOf(c["scopeKey"]), stringOf(c["entryId"]), 0)
		if view["state"] == "active" && integer(view["revision"]) == integer(c["afterRevision"]) && c["undoneBy"] == "" {
			batchID := ""
			if relation := s.row("SELECT batchId FROM naturalMemoryRelations WHERE changeId=?", c["id"]); relation != nil {
				batchID = stringOf(relation["batchId"])
			}
			result = append(result, Object{"changeId": c["id"], "scope": c["scopeKey"], "entryId": c["entryId"], "revision": c["afterRevision"], "batchId": batchID})
		}
	}
	return result
}
func naturalSourceAgeValid(snap ai.MemoryTurnSnapshot) bool {
	at, err := time.Parse(time.RFC3339Nano, snap.CapturedAt)
	return err == nil && time.Since(at) < 7*24*time.Hour && time.Until(at) < time.Minute
}
func naturalTextHasAny(text string, parts ...string) bool {
	lower := strings.ToLower(text)
	for _, p := range parts {
		if strings.Contains(lower, p) {
			return true
		}
	}
	return false
}

func naturalBefore(a, b string) bool {
	first, e := time.Parse(time.RFC3339Nano, a)
	second, e2 := time.Parse(time.RFC3339Nano, b)
	return e != nil || e2 != nil || first.Before(second)
}
func (s *Store) NaturalPreferenceChange(ctx StrategyContext, id string) (Object, error) {
	return strategyCall(s, false, func() Object {
		scope := s.strategyAuthorize(ctx, naturalScope(ctx))
		c := s.row("SELECT id,entryId,beforeRevision,afterRevision,kind,createdAt,undoneBy FROM naturalPreferenceChanges WHERE id=? AND scopeKey=?", id, scope)
		if c == nil {
			naturalFail(404, "change_unavailable")
		}
		c["after"] = s.naturalPreferenceView(scope, stringOf(c["entryId"]), integer(c["afterRevision"]))
		c["before"] = nil
		if integer(c["beforeRevision"]) > 0 {
			c["before"] = s.naturalPreferenceView(scope, stringOf(c["entryId"]), integer(c["beforeRevision"]))
		}
		return c
	})
}
func (s *Store) DismissNaturalPreferenceNotice(ctx StrategyContext, id string) (Object, error) {
	return strategyCall(s, true, func() Object {
		scope := s.strategyAuthorize(ctx, naturalScope(ctx))
		if s.row("SELECT id FROM naturalPreferenceChanges WHERE id=? AND scopeKey=?", id, scope) == nil {
			naturalFail(404, "change_unavailable")
		}
		s.exec("INSERT OR IGNORE INTO naturalPreferenceNoticeAcks VALUES(?)", id)
		return Object{"dismissed": true}
	})
}
