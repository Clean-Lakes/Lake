package web

import "time"

// Recovery is a one-way compatibility stop, never a resumption of the retired
// optimizer. Keep completed artifacts/usage/identities, and preserve uncertainty
// for any dispatched request. OpenStore calls this under its process lock and
// recovery transaction before workers exist. It is idempotent across restarts.
func (s *Store) recoverStrategyOptimizations() {
	for _, row := range s.rows(`SELECT j.*,o.stopReason,o.activeMs,o.activationStartedMs FROM strategyJobs j JOIN strategyOptimizations o ON o.jobId=j.id WHERE j.status IN ('queued','leased','awaiting_reconciliation') OR EXISTS(SELECT 1 FROM strategyOptimizationCalls c WHERE c.experimentId=j.id AND c.status='running') OR EXISTS(SELECT 1 FROM strategyExperimentRuns r WHERE r.experimentId=j.id AND r.status='running')`) {
		id := stringOf(row["id"])
		unknown := row["dispatchState"] == "intent" || row["dispatchState"] == "unknown" || row["dispatchState"] == "started" && row["status"] != "succeeded" || s.row("SELECT 1 FROM strategyOptimizationCalls WHERE experimentId=? AND status IN ('running','unknown')", id) != nil || s.row("SELECT 1 FROM strategyExperimentRuns WHERE experimentId=? AND status IN ('running','unknown')", id) != nil
		s.exec("UPDATE strategyOptimizationCalls SET status='unknown',errorCode='interrupted',finishedAt=? WHERE experimentId=? AND status='running'", now(), id)
		s.exec("UPDATE strategyOptimizationCalls SET status='not_executed',finishedAt=? WHERE experimentId=? AND status='planned'", now(), id)
		s.exec("UPDATE strategyExperimentRuns SET status='unknown',finishedAt=? WHERE experimentId=? AND status='running'", now(), id)
		s.exec("UPDATE strategyExperimentRuns SET status='not_executed',finishedAt=? WHERE experimentId=? AND status='planned'", now(), id)
		// A settled historical job retains its original outcome. Active uncertain
		// jobs stay uncertain and cannot be leased, resumed, saved, or dispatched.
		if row["status"] == "succeeded" || row["status"] == "failed" || row["status"] == "cancelled" {
			continue
		}
		reason, state, dispatch := "optimization_retired", "cancelled", stringOf(row["dispatchState"])
		if unknown {
			reason, state, dispatch = "awaiting_reconciliation", "awaiting_reconciliation", "unknown"
		}
		if row["stopReason"] == reason && row["status"] == state && row["leaseToken"] == "" && integer(row["activationStartedMs"]) == 0 {
			continue
		}
		active := int64(integer(row["activeMs"]))
		if start := int64(integer(row["activationStartedMs"])); start > 0 {
			active += max(int64(0), time.Now().UnixMilli()-start)
		}
		s.exec("UPDATE strategyOptimizations SET stopReason=?,activeMs=?,activationStartedMs=0,waitUntilMs=0 WHERE jobId=?", reason, active, id)
		s.exec("UPDATE strategyJobs SET status=?,errorCode=?,dispatchState=?,leaseToken='',leaseUntilMs=0,updatedAt=? WHERE id=?", state, reason, dispatch, now(), id)
		s.strategyEvent(stringOf(row["scopeKey"]), stringOf(row["accessProjectId"]), id, 1, "optimization_retired", Object{"unknown": unknown})
	}
}
