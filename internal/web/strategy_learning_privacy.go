package web

// Called inside the business deletion transaction, before its user messages go
// away. Historical references retain only identity/hash, never a private copy
// of the removed source or auxiliary response.
func (s *Store) strategyEraseSessionSources(sessionID string) {
	scopes := s.rows("SELECT DISTINCT scopeKey FROM strategySourceEvents WHERE sessionId=?", sessionID)
	s.eraseStrategyExperiments("jobId IN (SELECT j.jobId FROM strategyJobSources j JOIN strategySourceEvents e ON e.id=j.sourceId WHERE e.sessionId=?)", sessionID)
	if len(scopes) == 0 {
		return
	}
	s.exec("UPDATE strategyProposalRuns SET resultJSON='' WHERE jobId IN (SELECT j.jobId FROM strategyJobSources j JOIN strategySourceEvents e ON e.id=j.sourceId WHERE e.sessionId=?)", sessionID)
	s.exec("UPDATE strategyLearningTurns SET snapshotJSON='' WHERE sessionId=?", sessionID)
	s.exec("UPDATE strategySourceEvents SET availability='tombstoned',summary='' WHERE sessionId=?", sessionID)
	s.strategyInvalidateJobs("id IN (SELECT j.jobId FROM strategyJobSources j JOIN strategySourceEvents e ON e.id=j.sourceId WHERE e.sessionId=?)", sessionID)
	for _, scope := range scopes {
		key := stringOf(scope["scopeKey"])
		generation := s.strategyAdvanceScope(key)
		s.strategyEvent(key, "", sessionID, generation, "session_sources_deleted", Object{"sessionId": sessionID})
	}
}
func (s *Store) strategyEraseAssetResults(assetID string) {
	s.eraseStrategyExperiments("jobId IN (SELECT id FROM strategyJobs WHERE assetId=?)", assetID)
	s.exec("UPDATE strategyProposalRuns SET resultJSON='' WHERE jobId IN (SELECT substr(createdBy,5) FROM strategyRevisions WHERE assetId=? AND createdBy LIKE 'job:%') OR jobId IN (SELECT id FROM strategyJobs WHERE assetId=?)", assetID, assetID)
}
