package web

import "github.com/Clean-Lakes/Lake/internal/strategy"

func (s *Store) strategyInvalidateJobs(where string, args ...any) {
	// An unknown/dispatched intent keeps its runtime identity and dispatchState.
	// Cancelling optimization never asserts that an external effect was undone.
	s.exec("UPDATE strategyJobs SET status=CASE WHEN dispatchState IN ('intent','started','unknown') THEN 'awaiting_reconciliation' ELSE 'cancelled' END,leaseToken='',leaseUntilMs=0,errorCode='strategy_invalidated',updatedAt=? WHERE status IN ('queued','leased','awaiting_reconciliation') AND ("+where+")", append([]any{now()}, args...)...)
}

func (s *Store) strategySaveSettings(key string, value strategy.Settings) {
	s.exec("INSERT INTO strategySettings VALUES(?,?,?,?,?) ON CONFLICT(scopeKey) DO UPDATE SET revision=excluded.revision,epoch=excluded.epoch,body=excluded.body,updatedAt=excluded.updatedAt", key, value.Revision, value.Epoch, jsonText(value), now())
}

func (s *Store) strategyGeneration(key string) int64 {
	return int64(integer(s.row("SELECT generation FROM strategyScopes WHERE scopeKey=?", key)["generation"]))
}

func (s *Store) strategyAdvanceScope(key string) int64 {
	s.exec("UPDATE strategyScopes SET generation=generation+1 WHERE scopeKey=?", key)
	epoch := s.strategyGeneration(key)
	row := s.row("SELECT body FROM strategySettings WHERE scopeKey=?", key)
	if row != nil {
		settings := strategyDecode[strategy.Settings](stringOf(row["body"]))
		settings.Epoch = epoch
		s.strategySaveSettings(key, settings)
	}
	return epoch
}

func (s *Store) strategyArchiveProject(project string) {
	scope := strategy.Scope{Kind: strategy.ProjectScope, ProjectID: project}
	key := s.strategyEnsureScope(StrategyContext{ProjectID: project}, scope)
	s.strategyAdvanceScope(key)
	s.strategyInvalidateJobs("accessProjectId=? OR scopeKey=?", project, key)
	// Archival is a privacy boundary even if restored later.
	s.exec("UPDATE strategySourceEvents SET availability='revoked',summary='' WHERE scopeKey=?", key)
	s.pruneStrategyDerivedContent()
	s.strategyEvent(key, project, key, s.strategyGeneration(key), "scope_revoked", Object{"projectId": project})
}
