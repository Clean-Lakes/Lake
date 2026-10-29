package web

import (
	"context"
	"errors"
	"regexp"
	"strings"
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

const naturalBatchLimit = 6
const naturalBatchInputLimit = 64 * 1024

func (s *Store) claimNaturalPeers(first Object, snap ai.MemoryTurnSnapshot) []naturalBatchItem {
	return s.update(func() any {
		items := []naturalBatchItem{{Job: first, Snapshot: snap}}
		for _, job := range s.rows(`SELECT j.*,t.projectId,t.sessionId,t.turnId,t.epoch,t.knowledgeBaseRevision,t.snapshotJSON,t.snapshotHash,t.modelRefJSON FROM projectMemoryJobs j JOIN projectMemoryTurns t ON t.sequence=j.turnSequence WHERE t.projectId=? AND t.sessionId=? AND t.sequence>? AND j.status IN ('queued','retry_wait') AND j.nextAttemptAtMs<=? ORDER BY t.sequence LIMIT ?`, snap.ProjectID, snap.SessionID, first["turnSequence"], time.Now().UnixMilli(), naturalBatchLimit-1) {
			next, ok := naturalDecodeSnapshot(job)
			if !ok || next.ModelRef != snap.ModelRef || next.LegacyExtraction != snap.LegacyExtraction || next.Epoch != snap.Epoch || next.KnowledgeBaseRevision != snap.KnowledgeBaseRevision || jsonText(next.Natural) != jsonText(snap.Natural) || jsonText(next.TargetBindings) != jsonText(snap.TargetBindings) {
				break
			}
			if !naturalSourceAgeValid(next) || !s.naturalSnapshotValid(next) {
				break
			}
			probe := append(append([]naturalBatchItem{}, items...), naturalBatchItem{Job: job, Snapshot: next})
			// Leave omitted sources queued. No dispatch or coverage advancement for them.
			if len(jsonText(naturalConsolidationMessages(probe, nil, ""))) > naturalBatchInputLimit-16*1024 {
				break
			}
			token := ident()
			s.exec("UPDATE projectMemoryJobs SET status='running',attempts=attempts+1,leaseOwner='local',leaseToken=?,leaseUntilMs=?,updatedAt=? WHERE jobId=?", token, time.Now().Add(90*time.Second).UnixMilli(), now(), job["jobId"])
			job["leaseToken"] = token
			job["attempts"] = integer(job["attempts"]) + 1
			items = probe
			items[len(items)-1].Job = job
		}
		return items
	}).([]naturalBatchItem)
}
func (s *Store) naturalLocalExact(items []naturalBatchItem) ([]naturalBatchItem, bool) {
	out := append([]naturalBatchItem{}, items...)
	for i, item := range items {
		if item.Snapshot.LegacyExtraction && len(item.Snapshot.Evidence) > 0 {
			return nil, false
		}
		match := false
		for _, p := range s.naturalPreferenceIndex(item.Snapshot) {
			if p["body"] == item.Snapshot.UserText {
				scope := stringOf(p["scope"])
				r := NaturalPreferenceResult{SchemaVersion: 1, Decision: "save", Scope: scope, Quote: item.Snapshot.UserText, Topic: stringOf(p["topic"]), ExpectedRevision: integer(p["revision"]), Relation: "equivalent"}
				if validateNaturalPreferenceResult(item.Snapshot.UserText, r) == nil {
					out[i].Result = r
					out[i].Mutations = []MemoryExtractMutation{}
					match = true
					break
				}
			}
		}
		if !match {
			return nil, false
		}
	}
	return out, true
}
func (s *Store) naturalBatchUserGuard(items []naturalBatchItem) string {
	first := items[0].Snapshot
	return stringOf(s.row("SELECT id FROM messages WHERE sessionId=? AND role='user' ORDER BY createdAt DESC,rowid DESC LIMIT 1", first.SessionID)["id"])
}
func (s *Store) commitNaturalBatch(items []naturalBatchItem, usage ai.Usage, index []Object, guard, batch string) (bool, error) {
	return strategyCall(s, true, func() bool {
		if len(items) == 0 || len(items) > naturalBatchLimit || s.naturalBatchUserGuard(items) != guard {
			fail(409, "Natural source range changed")
		}
		first := items[0].Snapshot
		s.exec("INSERT INTO naturalMemoryBatches VALUES(?,?,?,?)", batch, first.ProjectID, first.SessionID, now())
		// Freeze allowed existing targets. Hidden/truncated entries cannot be guessed.
		targets := map[string]int{}
		for _, p := range index {
			scope := "project:" + first.ProjectID
			if p["scope"] == "user" {
				scope = "user"
			}
			targets[scope+"/"+stringOf(p["topic"])] = integer(p["revision"])
		}
		touched := map[string]int{}
		changed := false
		legacyKeys := map[string]bool{}
		for i, item := range items {
			r := item.Result
			snap := item.Snapshot
			job := item.Job
			if snap.ProjectID != first.ProjectID || snap.SessionID != first.SessionID || !s.naturalSnapshotValid(snap) {
				fail(409, "Batch source invalidated")
			}
			if validateNaturalPreferenceResult(snap.UserText, r) != nil {
				fail(400, "Invalid natural source")
			}
			// A later evidence interval may share a genuine user message with
			// an already committed preference. It cannot re-authorize a
			// correction or resolve a newer conflict; legacy facts still commit.
			if r.Decision == "save" && s.row("SELECT 1 FROM naturalPreferenceRevisions WHERE sourceMessage=? AND sourceHash=? LIMIT 1", snap.SourceMessageID, memoryHash(snap.UserText)) != nil {
				r = NaturalPreferenceResult{SchemaVersion: 1, Decision: "ignore", Scope: "none", Relation: "none"}
			}
			scope := "project:" + snap.ProjectID
			if r.Scope == "user" {
				scope = "user"
			}
			target := scope + "/" + r.Topic
			if r.Decision == "save" {
				current := s.row("SELECT id,revision,state FROM naturalPreferenceEntries WHERE scopeKey=? AND topic=?", scope, r.Topic)
				if rev, ok := touched[target]; ok {
					r.ExpectedRevision = rev
				} else if r.Relation != "new" {
					if targets[target] != r.ExpectedRevision || r.ExpectedRevision < 1 {
						fail(409, "Consolidation target was not supplied")
					}
				}
				if current != nil && r.Relation == "new" {
					view := s.naturalPreferenceView(scope, stringOf(current["id"]), 0)
					if view["body"] == r.Quote {
						r.Relation = "equivalent"
						r.ExpectedRevision = integer(current["revision"])
					} else {
						fail(409, "New preference conflicts with existing topic")
					}
				}
				if current != nil && r.Relation == "equivalent" {
					prior := s.naturalPreferenceView(scope, stringOf(current["id"]), 0)
					if naturalConditionKey(stringOf(prior["body"])) != naturalConditionKey(r.Quote) {
						fail(409, "Preference conditions differ; source remains uncovered")
					}
				}
				if current != nil && (r.Relation == "equivalent" || r.Relation == "correction" || r.Relation == "conflict") && integer(current["revision"]) != r.ExpectedRevision {
					fail(409, "Consolidation target changed")
				}
				if r.Relation == "correction" && current != nil {
					s.exec("UPDATE naturalPreferenceConflicts SET status='superseded',resolvedAt=? WHERE entryId=? AND status='pending'", now(), current["id"])
				}
			}
			// Legacy facts are committed under their original revision/evidence checks;
			// repeated keys inside one batch conservatively defer the whole transaction.
			for _, m := range item.Mutations {
				if legacyKeys[m.Key] {
					fail(409, "Repeated legacy fact needs a later batch")
				}
				legacyKeys[m.Key] = true
			}
			actual := r
			if r.Relation == "conflict" {
				s.naturalRecordConflict(snap, r)
				actual = NaturalPreferenceResult{SchemaVersion: 1, Decision: "review", Scope: "none"}
			}
			u := ai.Usage{}
			if i == 0 {
				u = usage
			}
			did := s.commitMemoryExtractionLocked(job, snap, item.Mutations, u, actual)
			changed = changed || did
			sourceKey := naturalCoverageKey(snap)
			if s.row("SELECT sourceKey FROM naturalMemoryCoverage WHERE sourceKey=?", sourceKey) == nil {
				s.exec("INSERT INTO naturalMemoryCoverage VALUES(?,?,?,?,?,?,'processed','',?)", sourceKey, job["turnSequence"], snap.ProjectID, snap.SessionID, snap.SourceMessageID, memoryHash(snap.UserText), now())
			}
			s.exec("INSERT INTO naturalMemoryBatchMembers VALUES(?,?,?)", batch, job["jobId"], sourceKey)
			c := s.row("SELECT id,entryId,afterRevision FROM naturalPreferenceChanges WHERE jobId=?", job["jobId"])
			if c != nil {
				relation := r.Relation
				if relation == "" || relation == "none" {
					relation = "new"
				}
				s.exec("INSERT INTO naturalMemoryRelations VALUES(?,?,?)", c["id"], relation, batch)
				touched[target] = integer(c["afterRevision"])
			}
		}
		return changed
	})
}
func (b *Server) settleNaturalBatch(items []naturalBatchItem, status, reason string, usage ai.Usage) {
	for i, item := range items {
		u := ai.Usage{}
		if i == 0 {
			u = usage
		}
		b.Store.SettleMemoryJob(stringOf(item.Job["jobId"]), stringOf(item.Job["leaseToken"]), status, reason, u)
	}
}
func (b *Server) processNaturalConsolidation(first Object, snapshot ai.MemoryTurnSnapshot) {
	if !naturalSourceAgeValid(snapshot) || !b.Store.read(func() any { return b.Store.naturalSnapshotValid(snapshot) }).(bool) {
		b.messageMu.Unlock()
		b.Store.SettleMemoryJob(stringOf(first["jobId"]), stringOf(first["leaseToken"]), "skipped", "natural_memory_invalidated", ai.Usage{})
		return
	}
	items := b.Store.claimNaturalPeers(first, snapshot)
	index := b.Store.read(func() any { return b.Store.naturalPreferenceIndex(snapshot) }).([]Object)
	guard := b.Store.read(func() any { return b.Store.naturalBatchUserGuard(items) }).(string)
	batch := ident()
	local := b.Store.read(func() any {
		r, ok := b.Store.naturalLocalExact(items)
		return struct {
			items []naturalBatchItem
			ok    bool
		}{r, ok}
	}).(struct {
		items []naturalBatchItem
		ok    bool
	})
	if local.ok {
		_, err := b.Store.commitNaturalBatch(local.items, ai.Usage{}, index, guard, batch)
		b.messageMu.Unlock()
		if err != nil {
			b.settleNaturalBatch(items, "blocked", "consolidation_conflict", ai.Usage{})
		}
		return
	}

	model := b.Models.ResolveModelIdentity(snapshot.ModelRef)
	if model == nil {
		b.messageMu.Unlock()
		b.settleNaturalBatch(items, "blocked", "model_unavailable", ai.Usage{})
		return
	}
	if model.MaxOutput <= 0 {
		model.MaxOutput = 4096
	} else if model.MaxOutput > 8192 {
		model.MaxOutput = 8192
	}
	memoryIndex := ""
	if snapshot.LegacyExtraction {
		memoryIndex = b.Store.ProjectMemoryIndex(snapshot.ProjectID)
	}
	messages := naturalConsolidationMessages(items, index, memoryIndex)
	if len(jsonText(messages)) > naturalBatchInputLimit {
		b.messageMu.Unlock()
		b.settleNaturalBatch(items, "blocked", "input_budget_uncovered", ai.Usage{})
		return
	}
	attempt := b.Store.update(func() any {
		start := time.Now().UTC().Truncate(24 * time.Hour)
		if integer(b.Store.row("SELECT count(*) n FROM naturalPreferenceDispatches WHERE projectId=? AND startedAt>=?", snapshot.ProjectID, start.Format(time.RFC3339Nano))["n"]) >= 20 || integer(b.Store.row("SELECT count(*) n FROM naturalPreferenceDispatches WHERE startedAt>=?", start.Format(time.RFC3339Nano))["n"]) >= 100 {
			for _, item := range items {
				b.Store.exec("UPDATE projectMemoryJobs SET status='budget_wait',attempts=max(0,attempts-1),nextAttemptAtMs=?,leaseToken='',leaseOwner='',leaseUntilMs=0,lastErrorCode='natural_daily_dispatch_limit',updatedAt=? WHERE jobId=? AND leaseToken=?", start.Add(24*time.Hour).UnixMilli(), now(), item.Job["jobId"], item.Job["leaseToken"])
				b.Store.exec("UPDATE naturalMemoryCoverage SET stage='deferred',reason='daily_dispatch_limit',updatedAt=? WHERE turnSequence=?", now(), item.Job["turnSequence"])
			}
			return ""
		}
		b.Store.exec("INSERT INTO naturalPreferenceDispatches(id,jobId,projectId,startedAt) VALUES(?,?,?,?)", batch, first["jobId"], snapshot.ProjectID, now())
		return batch
	}).(string)
	if attempt == "" {
		b.messageMu.Unlock()
		return
	}
	ctx, cancel := context.WithTimeout(b.Context, 60*time.Second)
	token := stringOf(first["leaseToken"])
	b.memoryCancel, b.memoryJobID, b.memoryLease = cancel, stringOf(first["jobId"]), token
	b.memoryBatchJobs = items
	b.messageMu.Unlock()
	var usage ai.Usage
	status := "failed"
	defer func() {
		cancel()
		b.Store.update(func() any {
			b.Store.exec("UPDATE naturalPreferenceDispatches SET finishedAt=?,status=?,usageJSON=? WHERE id=?", now(), status, jsonText(usage), attempt)
			return nil
		})
		b.messageMu.Lock()
		if b.memoryLease == token {
			b.memoryCancel = nil
			b.memoryJobID = ""
			b.memoryLease = ""
			b.memoryBatchJobs = nil
		}
		b.messageMu.Unlock()
	}()
	output, u, err := b.Engine.ExtractMemory(ctx, *model, messages)
	usage = u
	if err != nil {
		status = "model_error"
		settlement := "retry_wait"
		if errors.Is(err, ai.ErrModelOutputLimit) {
			settlement, status = "failed", "output_limit"
		}
		if strings.Contains(err.Error(), "context budget") {
			settlement, status = "blocked", "context_budget"
		}
		b.settleNaturalBatch(items, settlement, status, usage)
		return
	}
	parsed, err := parseNaturalConsolidation(output, items)
	if err != nil {
		status = "invalid_output"
		b.settleNaturalBatch(items, "failed", status, usage)
		return
	}
	if b.Terminals.containsCredential(output) || b.Models.strategyContainsProviderSecret(output) || !ai.SafeMemoryContent(output, *model) {
		status = "credential_detected"
		b.settleNaturalBatch(items, "failed", status, usage)
		return
	}
	b.messageMu.Lock()
	if len(b.runningMessages) > 0 || b.memoryForeground > 0 || ctx.Err() != nil {
		b.messageMu.Unlock()
		status = "foreground_preempted"
		b.settleNaturalBatch(items, "retry_wait", status, usage)
		return
	}
	_, err = b.Store.commitNaturalBatch(parsed, usage, index, guard, batch)
	b.messageMu.Unlock()
	if err != nil {
		status = "consolidation_conflict"
		b.settleNaturalBatch(items, "blocked", status, usage)
		return
	}
	if snapshot.LegacyExtraction {
		_ = b.Store.PublishProjectMemory(snapshot.ProjectID)
	}
	status = "succeeded"
}

// Caller holds messageMu. Only the consent actually used by this batch matters.
func (b *Server) pauseNaturalScope(ctx StrategyContext) {
	for _, item := range b.memoryBatchJobs {
		c := item.Snapshot.Natural
		if c != nil && (ctx.ProjectID == "" && c.GlobalEnabled || ctx.ProjectID == item.Snapshot.ProjectID && c.ProjectEnabled) {
			b.PauseMemoryExtractionForForeground()
			return
		}
	}
}

var naturalConditionPattern = regexp.MustCompile(`(?i)(只在|仅在|仅限|如果|针对|仅当|only when|only for|only in|when |if )[^。；;\n]*`)

func naturalConditionKey(body string) string {
	return strings.ToLower(strings.Join(naturalConditionPattern.FindAllString(body, -1), "\n"))
}
