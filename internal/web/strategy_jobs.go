package web

import (
	"time"

	"github.com/Clean-Lakes/Lake/internal/strategy"
)

type StrategyJobInput struct {
	Scope            strategy.Scope
	Kind, AssetID    string
	ExpectedRevision int64
	SourceIDs        []string
}

const strategyLeaseDuration = 90 * time.Second
const strategyMaxJobClaims = 3

func strategyValidationCode(fn func()) (code string) {
	defer func() {
		if p := recover(); p != nil {
			if e, ok := p.(*StrategyError); ok && e.Status < 500 {
				code = e.Code
			} else if _, ok := p.(*Failure); ok {
				code = "strategy_scope_unavailable"
			} else {
				panic(p)
			}
		}
	}()
	fn()
	return
}
func (s *Store) strategyJob(ctx StrategyContext, id string) Object {
	s.strategyContext(ctx)
	job := s.row("SELECT * FROM strategyJobs WHERE id=? AND accessProjectId=?", id, ctx.ProjectID)
	if job == nil {
		strategyFail(404, "job_unavailable")
	}
	s.strategyAuthorize(ctx, scopeFromRow(job))
	return job
}
func (s *Store) strategyJobSources(id string) []string {
	out := []string{}
	for _, source := range s.rows("SELECT sourceId FROM strategyJobSources WHERE jobId=? ORDER BY sourceId", id) {
		out = append(out, stringOf(source["sourceId"]))
	}
	return out
}
func (s *Store) strategyCheckJob(ctx StrategyContext, job Object) {
	settings := s.strategyEffective(ctx)
	if !settings.Settings.MasterEnabled || (job["kind"] == "proposal" && !settings.Settings.LearnEnabled) || (job["kind"] == "experiment" && (!settings.Settings.LearnEnabled || !settings.Settings.ApplyEnabled)) {
		strategyFail(409, "disabled")
	}
	if job["kind"] == "experiment" && !settings.Settings.CorrectEnabled && s.row("SELECT jobId FROM strategyOptimizations WHERE jobId=?", job["id"]) != nil {
		strategyFail(409, "correction_disabled")
	}
	if int64(integer(job["globalEpoch"])) != settings.GlobalEpoch || int64(integer(job["projectEpoch"])) != settings.ProjectEpoch {
		strategyFail(409, "stale_epoch")
	}
	if int64(integer(job["expiresAtMs"])) <= time.Now().UnixMilli() {
		strategyFail(409, "job_expired")
	}
	_, hash := s.strategySourceSet(ctx, s.strategyJobSources(stringOf(job["id"])))
	if hash != job["sourceSetHash"] {
		strategyFail(409, "source_changed")
	}
	if job["assetId"] != nil {
		a := s.strategyAsset(ctx, stringOf(job["assetId"]), false)
		if a["scopeKey"] != job["scopeKey"] || integer(a["revision"]) != integer(job["expectedRevision"]) {
			strategyFail(409, "revision_conflict")
		}
	}
}
func (s *Store) strategyCheckLease(ctx StrategyContext, job Object, token string) {
	if token == "" || job["leaseToken"] != token || int64(integer(job["leaseUntilMs"])) <= time.Now().UnixMilli() {
		strategyFail(409, "lease_expired")
	}
	if job["status"] != "leased" && job["status"] != "awaiting_reconciliation" {
		strategyFail(409, "job_not_active")
	}
	s.strategyCheckJob(ctx, job)
}
func (s *Store) QueueStrategyJob(ctx StrategyContext, key string, input StrategyJobInput) (StrategyMutationResult, error) {
	return strategyCall(s, true, func() StrategyMutationResult { return s.strategyQueueJob(ctx, key, input) })
}
func (s *Store) strategyQueueJob(ctx StrategyContext, key string, input StrategyJobInput) StrategyMutationResult {
	scopeKey := s.strategyEnsureScope(ctx, input.Scope)
	if input.Kind != "proposal" && input.Kind != "experiment" {
		strategyFail(400, "invalid_job")
	}
	// Automatic global candidates may only use explicitly global sources and a
	// global context. Promotion from a project's private history requires a new
	// user-confirmed global revision, not a worker choosing a wider scope.
	if input.Scope.Kind == strategy.UserScope && ctx.ProjectID != "" {
		strategyFail(403, "global_promotion_requires_confirmation")
	}
	sources, sourceHash := s.strategySourceSet(ctx, input.SourceIDs)
	input.SourceIDs = sources
	result, replayed, digest := s.strategyReceipt(scopeKey, key, Object{"operation": "queue", "input": input})
	if replayed {
		s.strategyJob(ctx, result.JobID)
		return result
	}
	effective := s.strategyEffective(ctx)
	if !effective.Settings.MasterEnabled || (input.Kind == "proposal" && !effective.Settings.LearnEnabled) || (input.Kind == "experiment" && (!effective.Settings.ApplyEnabled || !effective.Settings.LearnEnabled)) {
		strategyFail(409, "disabled")
	}
	var assetID any
	if input.AssetID != "" {
		a := s.strategyAsset(ctx, input.AssetID, false)
		if a["scopeKey"] != scopeKey || int64(integer(a["revision"])) != input.ExpectedRevision {
			strategyFail(409, "revision_conflict")
		}
		if input.Kind == "proposal" && effective.Settings.Budget.MaxRevisions == 0 {
			strategyFail(409, "revision_disabled")
		}
		assetID = input.AssetID
	} else if input.ExpectedRevision != 0 {
		strategyFail(400, "invalid_revision")
	}
	id := ident()
	stamp := now()
	s.exec(`INSERT INTO strategyJobs(id,scopeKey,accessProjectId,kind,assetId,expectedRevision,status,globalEpoch,projectEpoch,sourceSetHash,runtimeId,dispatchState,expiresAtMs,createdAt,updatedAt)
 VALUES(?,?,?,?,?,?,'queued',?,?,?,?,'none',?,?,?)`, id, scopeKey, ctx.ProjectID, input.Kind, assetID, input.ExpectedRevision, effective.GlobalEpoch, effective.ProjectEpoch, sourceHash, "strategy_"+id, time.Now().Add(time.Duration(effective.Settings.Budget.MaxActiveSeconds)*time.Second).UnixMilli(), stamp, stamp)
	for _, source := range sources {
		s.exec("INSERT INTO strategyJobSources VALUES(?,?)", id, source)
	}
	s.strategyEvent(scopeKey, ctx.ProjectID, id, 1, "job_queued", Object{"runtimeId": "strategy_" + id, "sourceSetHash": sourceHash})
	result = StrategyMutationResult{JobID: id}
	s.strategySaveReceipt(scopeKey, key, digest, result)
	return result
}

func (s *Store) GetStrategyJob(ctx StrategyContext, id string) (Object, error) {
	return strategyCall(s, false, func() Object { job := s.strategyJob(ctx, id); delete(job, "leaseToken"); return job })
}
func (s *Store) ClaimStrategyJob(ctx StrategyContext) (Object, error) {
	return s.claimStrategyJob(ctx, "")
}
func (s *Store) claimStrategyJob(ctx StrategyContext, kind string) (Object, error) {
	return strategyCall(s, true, func() Object {
		s.strategyContext(ctx)
		stamp := time.Now().UnixMilli()
		for _, job := range s.rows("SELECT * FROM strategyJobs WHERE accessProjectId=? AND (?='' OR kind=?) AND (status='queued' OR (status='leased' AND leaseUntilMs<=? AND dispatchState='none')) ORDER BY createdAt,id LIMIT 32", ctx.ProjectID, kind, kind, stamp) {
			if kind == "proposal" && s.row(`SELECT 1 FROM strategyJobSources js JOIN strategyLearningTurns t ON t.sourceId=js.sourceId JOIN projectMemoryTurns mt ON mt.sessionId=t.sessionId AND mt.turnId=t.turnId JOIN projectMemoryJobs mj ON mj.turnSequence=mt.sequence WHERE js.jobId=? AND mj.status IN ('queued','running','retry_wait') LIMIT 1`, job["id"]) != nil {
				continue
			}
			code := strategyValidationCode(func() { s.strategyCheckJob(ctx, job) })
			if integer(job["attempts"]) >= strategyMaxJobClaims {
				code = "strategy_claim_limit"
			}
			if code != "" {
				s.exec("UPDATE strategyJobs SET status='cancelled',leaseToken='',leaseUntilMs=0,errorCode=?,updatedAt=? WHERE id=?", code, now(), job["id"])
				s.strategyEvent(stringOf(job["scopeKey"]), ctx.ProjectID, stringOf(job["id"]), int64(integer(job["attempts"])), "job_cancelled", Object{"code": code})
				continue
			}
			if job["kind"] == "experiment" && s.row("SELECT id FROM strategyJobs WHERE kind='experiment' AND id<>? AND (status='leased' OR dispatchState IN ('intent','started','unknown')) LIMIT 1", job["id"]) != nil {
				continue
			}
			token := ident()
			until := min(time.Now().Add(strategyLeaseDuration).UnixMilli(), int64(integer(job["expiresAtMs"])))
			s.exec("UPDATE strategyJobs SET status='leased',leaseToken=?,leaseUntilMs=?,attempts=attempts+1,updatedAt=? WHERE id=?", token, until, now(), job["id"])
			s.strategyEvent(stringOf(job["scopeKey"]), ctx.ProjectID, stringOf(job["id"]), int64(integer(job["attempts"]))+1, "job_claimed", Object{"id": job["id"]})
			return s.strategyJob(ctx, stringOf(job["id"]))
		}
		return Object(nil)
	})
}
func (s *Store) CheckStrategyJobLease(ctx StrategyContext, id, token string) (bool, error) {
	return strategyCall(s, false, func() bool { s.strategyCheckLease(ctx, s.strategyJob(ctx, id), token); return true })
}
func (s *Store) RenewStrategyJobLease(ctx StrategyContext, id, token string) (Object, error) {
	return strategyCall(s, true, func() Object {
		job := s.strategyJob(ctx, id)
		s.strategyCheckLease(ctx, job, token)
		until := min(time.Now().Add(strategyLeaseDuration).UnixMilli(), int64(integer(job["expiresAtMs"])))
		s.exec("UPDATE strategyJobs SET leaseUntilMs=?,updatedAt=? WHERE id=?", until, now(), id)
		return s.strategyJob(ctx, id)
	})
}
func (s *Store) CancelStrategyJob(ctx StrategyContext, id, key string) (StrategyMutationResult, error) {
	return strategyCall(s, true, func() StrategyMutationResult {
		job := s.strategyJob(ctx, id)
		scopeKey := stringOf(job["scopeKey"])
		result, replayed, digest := s.strategyReceipt(scopeKey, key, Object{"operation": "cancel_job", "id": id})
		if replayed {
			return result
		}
		s.strategyInvalidateJobs("id=?", id)
		s.strategyEvent(scopeKey, ctx.ProjectID, id, int64(integer(job["attempts"])), "job_cancelled", Object{"id": id})
		result = StrategyMutationResult{JobID: id}
		s.strategySaveReceipt(scopeKey, key, digest, result)
		return result
	})
}

// Prepare is the durable outbox intent. Future adapters must call it BEFORE
// any external runtime/model task starts. A second prepare cannot dispatch.
func (s *Store) PrepareStrategyDispatch(ctx StrategyContext, id, token string) (string, error) {
	return strategyCall(s, true, func() string {
		job := s.strategyJob(ctx, id)
		s.strategyCheckLease(ctx, job, token)
		if job["status"] != "leased" || job["dispatchState"] != "none" {
			strategyFail(409, "reconciliation_required")
		}
		s.exec("UPDATE strategyJobs SET status='awaiting_reconciliation',dispatchState='intent',updatedAt=? WHERE id=?", now(), id)
		s.strategyEvent(stringOf(job["scopeKey"]), ctx.ProjectID, id, int64(integer(job["attempts"])), "dispatch_intent", Object{"runtimeId": job["runtimeId"]})
		return stringOf(job["runtimeId"])
	})
}

// Observations come from an authoritative runtime lookup in a future adapter,
// never from API/model claims. They record effects even after cancellation;
// they cannot reopen the job, publish a candidate or authorize another start.
func (s *Store) ObserveStrategyDispatch(ctx StrategyContext, id, runtimeID, state string) (bool, error) {
	return strategyCall(s, true, func() bool {
		// A trusted completion observation must survive project archival. It
		// returns no source text and cannot renew a lease or reopen cancelled work.
		job := s.row("SELECT * FROM strategyJobs WHERE id=? AND accessProjectId=?", id, ctx.ProjectID)
		if job == nil {
			strategyFail(404, "job_unavailable")
		}
		if ctx.ProjectID != "" && s.row("SELECT id FROM projects WHERE id=?", ctx.ProjectID) == nil {
			strategyFail(404, "scope_unavailable")
		}
		if runtimeID != job["runtimeId"] || job["dispatchState"] == "none" {
			strategyFail(409, "runtime_mismatch")
		}
		if state != "started" && state != "unknown" && state != "complete" {
			strategyFail(400, "invalid_dispatch_state")
		}
		if job["dispatchState"] == "complete" && state != "complete" {
			strategyFail(409, "settled_dispatch")
		}
		if job["dispatchState"] != state {
			s.exec("UPDATE strategyJobs SET dispatchState=?,updatedAt=? WHERE id=?", state, now(), id)
			s.strategyEvent(stringOf(job["scopeKey"]), ctx.ProjectID, id, int64(integer(job["attempts"])), "dispatch_observed", Object{"runtimeId": runtimeID, "state": state})
		}
		return true
	})
}
func (s *Store) AcquireStrategyReconciliation(ctx StrategyContext, id, runtimeID string) (Object, error) {
	return strategyCall(s, true, func() Object {
		job := s.strategyJob(ctx, id)
		s.strategyCheckJob(ctx, job)
		if runtimeID != job["runtimeId"] || job["status"] != "awaiting_reconciliation" || job["dispatchState"] == "none" {
			strategyFail(409, "reconciliation_required")
		}
		if stringOf(job["leaseToken"]) != "" && int64(integer(job["leaseUntilMs"])) > time.Now().UnixMilli() {
			strategyFail(409, "lease_active")
		}
		if integer(job["attempts"]) >= strategyMaxJobClaims {
			strategyFail(409, "claim_limit")
		}
		token := ident()
		s.exec("UPDATE strategyJobs SET leaseToken=?,leaseUntilMs=?,attempts=attempts+1,updatedAt=? WHERE id=?", token, min(time.Now().Add(strategyLeaseDuration).UnixMilli(), int64(integer(job["expiresAtMs"]))), now(), id)
		return s.strategyJob(ctx, id)
	})
}
func (s *Store) CompleteStrategyProposal(ctx StrategyContext, id, token string, input StrategyAssetInput) (StrategyMutationResult, error) {
	return strategyCall(s, true, func() StrategyMutationResult { return s.strategyCompleteProposal(ctx, id, token, input, false) })
}
func (s *Store) strategyCompleteProposal(ctx StrategyContext, id, token string, input StrategyAssetInput, dedup bool) StrategyMutationResult {
	job := s.strategyJob(ctx, id)
	validateStrategyInput(input)
	scopeKey := stringOf(job["scopeKey"])
	key := "job-result:" + id
	result, replayed, digest := s.strategyReceipt(scopeKey, key, Object{"operation": "proposal_result", "id": id, "input": input})
	if replayed {
		return result
	}
	s.strategyCheckLease(ctx, job, token)
	if job["kind"] != "proposal" || (job["status"] == "awaiting_reconciliation" && job["dispatchState"] != "complete") {
		strategyFail(409, "reconciliation_required")
	}
	if dedup {
		if result, code := s.strategyProposalDuplicate(ctx, job, input); code != "" {
			s.strategyFinishProposal(job, code)
			s.strategySaveReceipt(scopeKey, key, digest, result)
			return result
		}
	}

	assetID := stringOf(job["assetId"])
	parent := int64(integer(job["expectedRevision"]))
	var a Object
	if assetID == "" {
		assetID = ident()
		s.exec("INSERT INTO strategyAssets(id,scopeKey,kind,title,revision,createdAt) VALUES(?,?,?,?,1,?)", assetID, scopeKey, input.Kind, input.Title, now())
		a = s.strategyAsset(ctx, assetID, false)
	} else {
		a = s.strategyAsset(ctx, assetID, false)
		if input.Kind != strategy.AssetKind(stringOf(a["kind"])) {
			strategyFail(400, "immutable_asset_kind")
		}
	}
	s.strategyWriteRevision(ctx, a, parent+1, parent, input, s.strategyJobSources(id), strategy.SingleObservation, "job:"+id)
	s.exec("UPDATE strategyAssets SET title=? WHERE id=?", input.Title, assetID)
	s.exec("UPDATE strategyJobs SET status='succeeded',leaseToken='',leaseUntilMs=0,updatedAt=? WHERE id=?", now(), id)
	result = StrategyMutationResult{AssetID: assetID, Revision: parent + 1, JobID: id}
	s.strategySaveReceipt(scopeKey, key, digest, result)
	s.strategyEvent(scopeKey, ctx.ProjectID, id, int64(integer(job["attempts"])), "job_succeeded", result)
	return result
}

// Called only while OpenStore owns the process lock. Leased means no dispatch
// intent exists, so it may return to the queue. An intent never does.
func (s *Store) recoverStrategyJobs() {
	s.recoverStrategyExperiments()
	s.exec("UPDATE strategyProposalRuns SET status='unknown',errorCode='interrupted',finishedAt=? WHERE status='running'", now())
	s.exec("UPDATE strategyJobs SET status='queued',leaseToken='',leaseUntilMs=0,updatedAt=? WHERE status='leased' AND dispatchState='none'", now())
	s.exec("UPDATE strategyJobs SET leaseToken='',leaseUntilMs=0,dispatchState=CASE WHEN dispatchState='intent' THEN 'unknown' ELSE dispatchState END,updatedAt=? WHERE status='awaiting_reconciliation'", now())
}
