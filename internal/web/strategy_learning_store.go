package web

import (
	"strings"
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
	"github.com/Clean-Lakes/Lake/internal/strategy"
)

const strategyExtractorVersion = "proposal-v1"

// Only Engine-produced sealed outboxes reach this adapter, never HTTP/model
// snapshots. Real user input is rechecked against the business session/message.
func (s *Store) registerStrategyTurn(snapshot ai.StrategyTurnSnapshot) (string, error) {
	return strategyCall(s, true, func() string {
		if !ai.ValidStrategySnapshot(snapshot) {
			strategyFail(400, "invalid_snapshot")
		}
		ctx := StrategyContext{ProjectID: snapshot.ProjectID}
		scope := strategy.Scope{Kind: strategy.ProjectScope, ProjectID: ctx.ProjectID}
		key := s.strategyEnsureScope(ctx, scope)
		session := s.session(snapshot.SessionID)
		if session["projectId"] != ctx.ProjectID {
			strategyFail(404, "source_unavailable")
		}
		if old := s.row("SELECT sourceId,snapshotHash FROM strategyLearningTurns WHERE sessionId=? AND turnId=?", snapshot.SessionID, snapshot.TurnID); old != nil {
			if old["snapshotHash"] != snapshot.SnapshotHash {
				strategyFail(409, "source_conflict")
			}
			return stringOf(old["sourceId"])
		}
		effective := s.strategyEffective(ctx)
		if !effective.Settings.MasterEnabled || !effective.Settings.LearnEnabled || snapshot.GlobalEpoch != effective.GlobalEpoch || snapshot.ProjectEpoch != effective.ProjectEpoch {
			return ""
		}
		start, err := time.Parse(time.RFC3339Nano, snapshot.StartedAt)
		if err != nil || start.After(time.Now().Add(time.Second)) {
			strategyFail(400, "invalid_snapshot")
		}
		msg := s.row("SELECT id,text,createdAt FROM messages WHERE id=? AND sessionId=? AND role='user' AND text=?", snapshot.UserMessageID, snapshot.SessionID, snapshot.UserText)
		if msg == nil {
			strategyFail(404, "source_unavailable")
		}
		created, err := time.Parse(time.RFC3339Nano, stringOf(msg["createdAt"]))
		if err != nil || created.After(start) {
			strategyFail(409, "source_unavailable")
		}
		id := ident()
		s.exec("INSERT INTO strategySourceEvents VALUES(?,?,?,'task_outcome',?,'',?,'Completed host turn reference','available',?)", id, key, "turn:"+snapshot.TurnID, snapshot.SessionID, snapshot.SnapshotHash, now())
		s.exec("INSERT INTO strategyLearningTurns VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", id, ctx.ProjectID, snapshot.SessionID, snapshot.TurnID, msg["id"], strategy.ContentHash(snapshot.UserText), jsonText(snapshot), snapshot.SnapshotHash, snapshot.ModelRef, snapshot.GlobalEpoch, snapshot.ProjectEpoch, now())
		s.strategyNode("source:"+id, key, "task", "", 0, id)
		s.strategyEvent(key, ctx.ProjectID, id, 1, "source_registered", Object{"sourceId": id, "turnId": snapshot.TurnID})
		return id
	})
}
func (s *Store) QueueStrategyProposal(ctx StrategyContext, key string, input StrategyJobInput) (StrategyMutationResult, error) {
	return strategyCall(s, true, func() StrategyMutationResult {
		if ctx.ProjectID == "" || input.Scope.Kind != strategy.ProjectScope || input.Kind != "proposal" || len(input.SourceIDs) > 8 {
			strategyFail(400, "invalid_proposal")
		}
		scopeKey := s.strategyAuthorize(ctx, input.Scope)
		sources, hash := s.strategySourceSet(ctx, input.SourceIDs)
		input.SourceIDs = sources
		for _, id := range sources {
			kind := s.strategySource(ctx, id, true)["kind"]
			if kind != "user_correction" && kind != "task_outcome" {
				strategyFail(400, "unsupported_source")
			}
		}
		result, replayed, digest := s.strategyReceipt(scopeKey, key, Object{"operation": "proposal", "input": input, "extractor": strategyExtractorVersion})
		if replayed {
			return result
		}
		effective := s.strategyEffective(ctx)
		if !effective.Settings.MasterEnabled || !effective.Settings.LearnEnabled {
			strategyFail(409, "disabled")
		}
		existing := s.row("SELECT id FROM strategyJobs WHERE scopeKey=? AND kind='proposal' AND sourceSetHash=? AND COALESCE(assetId,'')=? AND expectedRevision=? AND globalEpoch=? AND projectEpoch=? AND status IN ('queued','leased','awaiting_reconciliation','succeeded') ORDER BY createdAt,id LIMIT 1", scopeKey, hash, input.AssetID, input.ExpectedRevision, effective.GlobalEpoch, effective.ProjectEpoch)
		if existing != nil {
			result = StrategyMutationResult{JobID: stringOf(existing["id"])}
		} else {
			result = s.strategyQueueJob(ctx, "dispatch:"+strategy.ContentHash(key+digest), input)
		}
		s.strategySaveReceipt(scopeKey, key, digest, result)
		return result
	})
}
func (s *Store) strategyProposalSources(ctx StrategyContext, job Object) []Object {
	out := []Object{}
	for _, id := range s.strategyJobSources(stringOf(job["id"])) {
		source := s.strategySource(ctx, id, true)
		value := Object{"sourceId": id, "kind": source["kind"]}
		switch source["kind"] {
		case "user_correction":
			value["userText"] = s.row("SELECT text FROM messages WHERE id=?", source["messageId"])["text"]
		case "task_outcome":
			turn := s.row("SELECT snapshotJSON FROM strategyLearningTurns WHERE sourceId=?", id)
			value["turn"] = strategyDecode[ai.StrategyTurnSnapshot](stringOf(turn["snapshotJSON"]))
		default:
			strategyFail(400, "unsupported_source")
		}
		out = append(out, value)
	}
	return out
}
func (s *Store) strategyFinishProposal(job Object, code string) {
	s.exec("UPDATE strategyJobs SET status='succeeded',leaseToken='',leaseUntilMs=0,errorCode=?,updatedAt=? WHERE id=?", code, now(), job["id"])
	s.strategyEvent(stringOf(job["scopeKey"]), stringOf(job["accessProjectId"]), stringOf(job["id"]), int64(integer(job["attempts"])), "proposal_no_op", Object{"code": code})
}

const strategyWhitespace = " \t\n\v\f\r\u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000"

func strategyComparableBody(body string) string {
	return strings.TrimSpace(strings.ReplaceAll(body, "\r\n", "\n"))
}
func (s *Store) strategyProposalDuplicate(ctx StrategyContext, job Object, in StrategyAssetInput) (StrategyMutationResult, string) {
	if job["assetId"] == nil && s.row("SELECT 1 FROM strategyRevisions r JOIN strategyAssets a ON a.id=r.assetId WHERE a.deletedAt='' AND a.scopeKey=? AND r.sourceSetHash=? LIMIT 1", job["scopeKey"], job["sourceSetHash"]) != nil {
		return StrategyMutationResult{JobID: stringOf(job["id"])}, "duplicate_source"
	}
	if s.row("SELECT 1 FROM strategyAssets a JOIN strategyRevisions r ON r.assetId=a.id JOIN strategyRevisionContent c ON c.assetId=r.assetId AND c.revision=r.revision WHERE a.deletedAt='' AND (a.scopeKey='user' OR a.scopeKey=?) AND trim(replace(c.body,char(13)||char(10),char(10)),?)=? LIMIT 1", "project:"+ctx.ProjectID, strategyWhitespace, strategyComparableBody(in.Body)) != nil {
		return StrategyMutationResult{JobID: stringOf(job["id"])}, "duplicate_asset"
	}

	for _, source := range s.strategyJobSources(stringOf(job["id"])) {
		if turn := s.row("SELECT snapshotJSON FROM strategyLearningTurns WHERE sourceId=?", source); turn != nil && strategyDecode[ai.StrategyTurnSnapshot](stringOf(turn["snapshotJSON"])).IgnoreProjectMemory {
			return StrategyMutationResult{}, ""
		}
	}
	settings := s.memorySettings(ctx.ProjectID)
	if settings["useEnabled"] == true {
		for _, row := range s.rows("SELECT body FROM projectMemories WHERE projectId=? AND deletedAt='' AND (validUntil='' OR validUntil>?)", ctx.ProjectID, now()) {
			if strategyComparableBody(stringOf(row["body"])) == strategyComparableBody(in.Body) {
				return StrategyMutationResult{JobID: stringOf(job["id"])}, "duplicate_memory"
			}
		}
	}
	return StrategyMutationResult{}, ""
}
func (s *Store) strategyProposalData(ctx StrategyContext, id, token string) (Object, error) {
	return strategyCall(s, false, func() Object {
		job := s.strategyJob(ctx, id)
		s.strategyCheckLease(ctx, job, token)
		data := Object{"sources": s.strategyProposalSources(ctx, job), "profile": "core", "modelRef": ""}
		for _, source := range s.strategyJobSources(id) {
			if turn := s.row("SELECT snapshotJSON,modelRef FROM strategyLearningTurns WHERE sourceId=?", source); turn != nil {
				snapshot := strategyDecode[ai.StrategyTurnSnapshot](stringOf(turn["snapshotJSON"]))
				if data["modelRef"] != "" && (data["modelRef"] != snapshot.ModelRef || data["profile"] != snapshot.Profile) {
					strategyFail(400, "mixed_context_sources")
				}
				if snapshot.IgnoreProjectMemory {
					data["ignoreProjectMemory"] = true
				}
				data["profile"] = snapshot.Profile
				data["modelRef"] = turn["modelRef"]
			}
		}
		if job["assetId"] != nil {
			view := s.strategyRevisionView(ctx, stringOf(job["assetId"]), int64(integer(job["expectedRevision"])))
			data["existingAsset"] = view.Value
		}
		return data
	})
}
func (s *Store) beginStrategyProposalRun(ctx StrategyContext, id, token, requestHash string) (Object, error) {
	return strategyCall(s, true, func() Object {
		job := s.strategyJob(ctx, id)
		s.strategyCheckLease(ctx, job, token)
		if job["dispatchState"] != "none" || s.row("SELECT 1 FROM strategyProposalRuns WHERE jobId=?", id) != nil {
			strategyFail(409, "reconciliation_required")
		}
		s.exec("INSERT INTO strategyProposalRuns(jobId,runtimeId,status,requestHash,leaseHash,startedAt) VALUES(?,?,'running',?,?,?)", id, job["runtimeId"], requestHash, strategy.ContentHash(token), now())
		s.exec("UPDATE strategyJobs SET status='awaiting_reconciliation',dispatchState='started',updatedAt=? WHERE id=?", now(), id)
		return s.strategyJob(ctx, id)
	})
}
func (s *Store) saveStrategyProposalRun(ctx StrategyContext, id, token string, result any, usage ai.Usage, code string) (bool, error) {
	return strategyCall(s, true, func() bool {
		job := s.row("SELECT * FROM strategyJobs WHERE id=? AND accessProjectId=?", id, ctx.ProjectID)
		if job == nil {
			strategyFail(409, "lease_expired")
		}
		run := s.row("SELECT status,leaseHash FROM strategyProposalRuns WHERE jobId=?", id)
		if run == nil || run["status"] != "running" || run["leaseHash"] != strategy.ContentHash(token) {
			strategyFail(409, "settled_dispatch")
		}
		status := "succeeded"
		body := ""
		if code != "" {
			status = "failed"
		} else {
			if job["status"] == "cancelled" {
				status, code = "failed", "cancelled"
			} else {
				body = jsonText(result)
			}
		}
		s.exec("UPDATE strategyProposalRuns SET status=?,resultJSON=?,usageJSON=?,errorCode=?,finishedAt=? WHERE jobId=?", status, body, jsonText(usage), code, now(), id)
		s.exec("UPDATE strategyJobs SET dispatchState='complete',updatedAt=? WHERE id=?", now(), id)
		return true
	})
}
func (s *Store) failStrategyProposal(ctx StrategyContext, id, code string) (bool, error) {
	return strategyCall(s, true, func() bool {
		job := s.row("SELECT * FROM strategyJobs WHERE id=? AND accessProjectId=?", id, ctx.ProjectID)
		if job == nil {
			strategyFail(404, "job_unavailable")
		}
		if job["status"] == "succeeded" || job["status"] == "cancelled" {
			return false
		}
		s.exec("UPDATE strategyJobs SET status='failed',leaseToken='',leaseUntilMs=0,errorCode=?,updatedAt=? WHERE id=?", code, now(), id)
		s.strategyEvent(stringOf(job["scopeKey"]), ctx.ProjectID, id, int64(integer(job["attempts"])), "job_failed", Object{"code": code})
		return true
	})
}
