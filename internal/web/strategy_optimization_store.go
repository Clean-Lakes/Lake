package web

import "time"

var optimizationVariants = []string{"baseline_development", "proposal_development", "synthesis_development", "baseline_holdout", "synthesis_holdout"}

func (s *Store) strategyPlanOptimization(id string, f strategyExperimentFrozen) {
	s.exec("INSERT INTO strategyOptimizations(jobId) VALUES(?)", id)
	for _, stage := range []string{"propose", "synthesize"} {
		s.exec("INSERT INTO strategyOptimizationCalls(id,experimentId,stage) VALUES(?,?,?)", ident(), id, stage)
	}
	for i, variant := range optimizationVariants {
		arm := "assets"
		caseID := f.Cases[0].ID
		if i == 0 || i == 3 {
			arm = "baseline"
		}
		if i >= 3 {
			caseID = f.Cases[1].ID
		}
		s.exec("INSERT INTO strategyExperimentRuns(id,experimentId,ordinal,caseId,arm,repetition,status,variant) VALUES(?,?,?,?,?,1,'planned',?)", ident(), id, i+1, caseID, arm, variant)
	}
	job := s.row("SELECT scopeKey,accessProjectId FROM strategyJobs WHERE id=?", id)
	s.strategyEvent(stringOf(job["scopeKey"]), stringOf(job["accessProjectId"]), id, 1, "optimization_created", Object{"runs": 5, "maxRevisions": 2})
}

func (s *Store) checkpointOptimization(ctx StrategyContext, id, token string, next int) (bool, error) {
	return strategyCall(s, true, func() bool {
		s.strategyCheckLease(ctx, s.strategyJob(ctx, id), token)
		stamp := time.Now().UnixMilli()
		s.exec("UPDATE strategyOptimizations SET stage=?,activeMs=activeMs+CASE WHEN activationStartedMs>0 THEN MAX(0,?-activationStartedMs) ELSE 0 END,activationStartedMs=? WHERE jobId=?", next, stamp, stamp, id)
		s.strategyEvent("project:"+ctx.ProjectID, ctx.ProjectID, id, int64(next), "optimization_checkpoint", Object{"stage": next})
		return true
	})
}
func (s *Store) finishOptimization(ctx StrategyContext, id, token, reason string) (bool, error) {
	return strategyCall(s, true, func() bool {
		job := s.row("SELECT * FROM strategyJobs WHERE id=? AND accessProjectId=?", id, ctx.ProjectID)
		if job == nil {
			strategyFail(404, "job_unavailable")
		}
		code := strategyValidationCode(func() { s.strategyCheckLease(ctx, job, token) })
		if job["status"] == "cancelled" {
			reason = "cancelled"
		} else if code == "strategy_job_expired" {
			reason = "budget_exhausted"
		} else if code != "" {
			reason = "source_changed"
		}
		stamp := time.Now().UnixMilli()
		s.exec("UPDATE strategyOptimizations SET stopReason=?,activeMs=activeMs+CASE WHEN activationStartedMs>0 THEN MAX(0,?-activationStartedMs) ELSE 0 END,activationStartedMs=0,waitUntilMs=0 WHERE jobId=?", reason, stamp, id)
		s.exec("UPDATE strategyExperimentRuns SET status=CASE WHEN status='running' THEN 'unknown' ELSE 'not_executed' END,finishedAt=? WHERE experimentId=? AND status IN ('running','planned')", now(), id)
		s.exec("UPDATE strategyOptimizationCalls SET status=CASE WHEN status='running' THEN 'unknown' ELSE 'not_executed' END,finishedAt=? WHERE experimentId=? AND status IN ('running','planned')", now(), id)
		if job["status"] != "cancelled" {
			state := "failed"
			if reason == "completed" || reason == "no_progress" || reason == "no_candidate" || reason == "permission_blocked" || reason == "target_ambiguous" || reason == "capability_missing" || reason == "awaiting_reconciliation" {
				state = "succeeded"
			}
			s.exec("UPDATE strategyJobs SET status=?,errorCode=?,leaseToken='',leaseUntilMs=0,updatedAt=? WHERE id=?", state, reason, now(), id)
		}
		s.strategyEvent(stringOf(job["scopeKey"]), ctx.ProjectID, id, 1, "optimization_stopped", Object{"reason": reason})
		return true
	})
}
func (s *Store) recoverStrategyOptimizations() {
	stamp := time.Now().UnixMilli()
	for _, row := range s.rows("SELECT j.*,o.stage,o.stopReason,o.activeMs,o.activationStartedMs,e.frozenJSON FROM strategyJobs j JOIN strategyOptimizations o ON o.jobId=j.id JOIN strategyExperiments e ON e.jobId=j.id WHERE j.dispatchState<>'none'") {
		id := stringOf(row["id"])
		unknown := s.row("SELECT 1 FROM strategyOptimizationCalls WHERE experimentId=? AND status IN ('running','unknown')", id) != nil || s.row("SELECT 1 FROM strategyExperimentRuns WHERE experimentId=? AND status IN ('running','unknown')", id) != nil
		s.exec("UPDATE strategyOptimizationCalls SET status='unknown',errorCode='interrupted',finishedAt=? WHERE experimentId=? AND status='running'", now(), id)
		s.exec("UPDATE strategyExperimentRuns SET status='unknown',finishedAt=? WHERE experimentId=? AND status='running'", now(), id)
		if row["status"] == "succeeded" || row["status"] == "cancelled" || row["status"] == "failed" {
			s.exec("UPDATE strategyExperimentRuns SET status='not_executed',finishedAt=? WHERE experimentId=? AND status='planned'", now(), id)
			s.exec("UPDATE strategyOptimizationCalls SET status='not_executed',finishedAt=? WHERE experimentId=? AND status='planned'", now(), id)
			s.exec("UPDATE strategyJobs SET dispatchState='complete',leaseToken='',leaseUntilMs=0 WHERE id=?", id)
			continue
		}
		if row["stopReason"] == "awaiting_user" && integer(row["activationStartedMs"]) == 0 && !unknown {
			continue
		}
		f := strategyExperimentFrozen{}
		if row["frozenJSON"] != "" {
			f = strategyDecode[strategyExperimentFrozen](stringOf(row["frozenJSON"]))
		}
		active := int64(integer(row["activeMs"]))
		start := int64(integer(row["activationStartedMs"]))
		if start > 0 {
			active += max(int64(0), stamp-start)
		}
		active = min(active, f.Budget.MaxActiveSeconds*1000)
		reason := "awaiting_user"
		state := "awaiting_reconciliation"
		if unknown {
			reason = "awaiting_reconciliation"
			state = "failed"
		}
		if f.Optimization == false || row["frozenJSON"] == "" {
			reason = "source_changed"
			state = "failed"
		}
		if active >= f.Budget.MaxActiveSeconds*1000 && !unknown {
			reason = "budget_exhausted"
			state = "failed"
		}
		if state == "failed" {
			s.exec("UPDATE strategyExperimentRuns SET status='not_executed',finishedAt=? WHERE experimentId=? AND status='planned'", now(), id)
			s.exec("UPDATE strategyOptimizationCalls SET status='not_executed',finishedAt=? WHERE experimentId=? AND status='planned'", now(), id)
		}
		s.exec("UPDATE strategyOptimizations SET stopReason=?,activeMs=?,activationStartedMs=0,waitUntilMs=? WHERE jobId=?", reason, active, stamp+f.Budget.UserWaitTTLSeconds*1000, id)
		s.exec("UPDATE strategyJobs SET status=?,errorCode=?,dispatchState='complete',leaseToken='',leaseUntilMs=0,updatedAt=? WHERE id=?", state, reason, now(), id)
	}
}
func (s *Store) resumeOptimization(ctx StrategyContext, id, key string) (StrategyMutationResult, error) {
	return strategyCall(s, true, func() StrategyMutationResult {
		job := s.strategyJob(ctx, id)
		result, replayed, digest := s.strategyReceipt(stringOf(job["scopeKey"]), key, Object{"operation": "resume_optimization", "id": id})
		if replayed {
			return result
		}
		o := s.row("SELECT * FROM strategyOptimizations WHERE jobId=?", id)
		e := s.row("SELECT * FROM strategyExperiments WHERE jobId=?", id)
		if o == nil || e == nil || e["frozenJSON"] == "" || o["stopReason"] != "awaiting_user" || job["status"] != "awaiting_reconciliation" || job["dispatchState"] != "complete" {
			strategyFail(409, "resume_unavailable")
		}
		if int64(integer(o["waitUntilMs"])) <= time.Now().UnixMilli() {
			strategyFail(409, "wait_expired")
		}
		if s.row("SELECT 1 FROM strategyOptimizationCalls WHERE experimentId=? AND status IN ('running','unknown')", id) != nil || s.row("SELECT 1 FROM strategyExperimentRuns WHERE experimentId=? AND status IN ('running','unknown')", id) != nil {
			strategyFail(409, "reconciliation_required")
		}
		f := strategyDecode[strategyExperimentFrozen](stringOf(e["frozenJSON"]))
		remaining := f.Budget.MaxActiveSeconds*1000 - int64(integer(o["activeMs"]))
		commitOnly := integer(o["stage"]) == 7 || integer(o["stage"]) == 6 && s.row("SELECT 1 FROM strategyExperimentRuns WHERE experimentId=? AND variant='synthesis_holdout' AND status='completed' AND reportJSON<>''", id) != nil
		if remaining <= 0 || !commitOnly && (integer(e["requests"]) >= f.Budget.MaxOptimizationRequests || int64(integer(e["tokensCharged"])) >= f.Budget.MaxAdditionalTokens) {
			strategyFail(409, "experiment_budget")
		}
		if integer(job["attempts"]) >= strategyMaxJobClaims {
			strategyFail(409, "claim_limit")
		}
		job["expiresAtMs"] = time.Now().UnixMilli() + remaining
		s.strategyCheckJob(ctx, job)
		s.exec("UPDATE strategyJobs SET status='queued',dispatchState='none',errorCode='',expiresAtMs=?,updatedAt=? WHERE id=?", job["expiresAtMs"], now(), id)
		s.exec("UPDATE strategyOptimizations SET stopReason='',waitUntilMs=0 WHERE jobId=?", id)
		s.strategyEvent(stringOf(job["scopeKey"]), ctx.ProjectID, id, int64(integer(o["stage"])), "optimization_resumed", Object{"stage": o["stage"]})
		result = StrategyMutationResult{JobID: id}
		s.strategySaveReceipt(stringOf(job["scopeKey"]), key, digest, result)
		return result
	})
}
