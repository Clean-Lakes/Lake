package web

// Historical fixture support only: never compiled into the Lake product.

import (
	"time"

	"github.com/Clean-Lakes/Lake/internal/testsupport/legacystrategy"

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
	strategyFail(410, "execution_retired")
	settings := s.strategyEffective(ctx)
	if !settings.Settings.MasterEnabled || (job["kind"] == "proposal" && !settings.Settings.LearnEnabled) || (job["kind"] == "experiment" && !settings.Settings.ApplyEnabled) {
		strategyFail(409, "disabled")
	}
	if job["kind"] == "experiment" && s.row("SELECT jobId FROM strategyOptimizations WHERE jobId=?", job["id"]) != nil {
		strategyFail(410, "optimization_retired")
	}
	if int64(integer(job["globalEpoch"])) != settings.GlobalEpoch || int64(integer(job["projectEpoch"])) != settings.ProjectEpoch {
		strategyFail(409, "stale_epoch")
	}
	if int64(integer(job["expiresAtMs"])) <= time.Now().UnixMilli() {
		strategyFail(409, "job_expired")
	}
	if job["kind"] == "proposal" && s.row("SELECT 1 FROM strategyRejections WHERE scopeKey=? AND sourceSetHash=?", job["scopeKey"], job["sourceSetHash"]) != nil {
		strategyFail(409, "rejected_source")
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

func (s *Store) strategyQueueJob(ctx StrategyContext, key string, input StrategyJobInput) StrategyMutationResult {
	scopeKey := s.strategyEnsureScope(ctx, input.Scope)
	strategyFail(410, "execution_retired")
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
	if !effective.Settings.MasterEnabled || (input.Kind == "proposal" && !effective.Settings.LearnEnabled) || (input.Kind == "experiment" && !effective.Settings.ApplyEnabled) {
		strategyFail(409, "disabled")
	}
	var assetID any
	if input.AssetID != "" {
		a := s.strategyAsset(ctx, input.AssetID, false)
		if a["scopeKey"] != scopeKey || int64(integer(a["revision"])) != input.ExpectedRevision {
			strategyFail(409, "revision_conflict")
		}
		assetID = input.AssetID
	} else if input.ExpectedRevision != 0 {
		strategyFail(400, "invalid_revision")
	}
	if input.Kind == "proposal" && s.row("SELECT 1 FROM strategyRejections WHERE scopeKey=? AND sourceSetHash=?", scopeKey, sourceHash) != nil {
		strategyFail(409, "rejected_source")
	}
	ttl := time.Duration(effective.Settings.Budget.MaxActiveSeconds) * time.Second
	if input.Kind == "proposal" {
		limits := legacystrategy.DefaultLearningLimits()
		pending := s.row("SELECT COUNT(*) AS total,COALESCE(SUM(CASE WHEN accessProjectId=? THEN 1 ELSE 0 END),0) AS projectTotal FROM strategyJobs WHERE kind='proposal' AND status IN ('queued','leased','awaiting_reconciliation')", ctx.ProjectID)
		if integer(pending["total"]) >= limits.MaxQueued || integer(pending["projectTotal"]) >= limits.MaxProjectQueued {
			strategyFail(409, "learning_queue_full")
		}
		ttl = time.Duration(limits.MaxQueueAgeSeconds) * time.Second
	}

	id := ident()
	stamp := now()
	s.exec(`INSERT INTO strategyJobs(id,scopeKey,accessProjectId,kind,assetId,expectedRevision,status,globalEpoch,projectEpoch,sourceSetHash,runtimeId,dispatchState,expiresAtMs,createdAt,updatedAt)
 VALUES(?,?,?,?,?,?,'queued',?,?,?,?,'none',?,?,?)`, id, scopeKey, ctx.ProjectID, input.Kind, assetID, input.ExpectedRevision, effective.GlobalEpoch, effective.ProjectEpoch, sourceHash, "strategy_"+id, time.Now().Add(ttl).UnixMilli(), stamp, stamp)
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
		if strategy.ExecutionRetired {
			return nil
		}
		stamp := time.Now().UnixMilli()
		for _, job := range s.rows("SELECT * FROM strategyJobs WHERE accessProjectId=? AND (?='' OR kind=?) AND (status='queued' OR (status='leased' AND leaseUntilMs<=? AND dispatchState='none')) ORDER BY createdAt,id LIMIT 32", ctx.ProjectID, kind, kind, stamp) {
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
