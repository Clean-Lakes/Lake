package web

import "github.com/Clean-Lakes/Lake/internal/strategy"

// Run under OpenStore's lock and recovery transaction, before any worker starts.
// The old apply choices and content bindings are deliberately independent.
func (s *Store) retireStrategyExecution() {
	for _, row := range s.rows("SELECT scopeKey,body FROM strategySettings") {
		old := strategyDecode[strategy.Settings](stringOf(row["body"]))
		if old.ExecutionRetirementVersion == strategy.ExecutionRetirementVersion && !old.LearnEnabled && !old.CorrectEnabled && !old.OnlineCorrectEnabled {
			continue
		}
		value := old
		if value.RetiredExecutionChoices == nil {
			value.RetiredExecutionChoices = &strategy.RetiredExecutionChoices{LearnEnabled: old.LearnEnabled, CorrectEnabled: old.CorrectEnabled, OnlineCorrectEnabled: old.OnlineCorrectEnabled, OnlineConsentVersion: old.OnlineConsentVersion, SettingsRevision: old.Revision, Epoch: old.Epoch}
		}
		value.LearnEnabled, value.CorrectEnabled, value.OnlineCorrectEnabled = false, false, false
		value.OnlineConsentVersion = 0
		value.ExecutionRetirementVersion = strategy.ExecutionRetirementVersion
		value.Revision++
		key := stringOf(row["scopeKey"])
		value.Epoch = s.strategyAdvanceScope(key)
		s.strategySaveSettings(key, value)
		s.strategyEvent(key, old.Scope.ProjectID, key, value.Revision, "strategy_execution_retired", Object{"version": strategy.ExecutionRetirementVersion})
	}
}

func (s *Store) retireStrategyJobs() {
	// Keep the prior optimizer's stage/timing retirement and its unknown calls.
	s.recoverStrategyOptimizations()
	s.exec("UPDATE strategyProposalRuns SET status='unknown',errorCode='strategy_execution_retired',finishedAt=? WHERE status='running'", now())
	s.exec("UPDATE strategyExperimentRuns SET status='unknown',finishedAt=? WHERE status='running'", now())
	s.exec("UPDATE strategyExperimentRuns SET status='not_executed',finishedAt=? WHERE status='planned'", now())
	for _, row := range s.rows("SELECT * FROM strategyJobs WHERE status IN ('queued','leased','awaiting_reconciliation')") {
		id := stringOf(row["id"])
		unknown := row["dispatchState"] == "intent" || row["dispatchState"] == "started" || row["dispatchState"] == "unknown" || s.row("SELECT 1 FROM strategyProposalRuns WHERE jobId=? AND status='unknown'", id) != nil || s.row("SELECT 1 FROM strategyExperimentRuns WHERE experimentId=? AND status='unknown'", id) != nil || s.row("SELECT 1 FROM strategyOptimizationCalls WHERE experimentId=? AND status='unknown'", id) != nil
		status, dispatch := "cancelled", stringOf(row["dispatchState"])
		if unknown {
			status, dispatch = "awaiting_reconciliation", "unknown"
		}
		if row["status"] == status && row["dispatchState"] == dispatch && row["errorCode"] == "strategy_execution_retired" && row["leaseToken"] == "" && integer(row["leaseUntilMs"]) == 0 {
			continue
		}
		// No usage, request hash, runtime identity or durable result is erased.
		s.exec("UPDATE strategyJobs SET status=?,dispatchState=?,errorCode='strategy_execution_retired',leaseToken='',leaseUntilMs=0,updatedAt=? WHERE id=?", status, dispatch, now(), id)
	}
}
