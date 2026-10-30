package web

func (s *Store) eraseStrategyExperiments(where string, args ...any) {
	s.exec("UPDATE strategyOptimizationCalls SET resultJSON='' WHERE experimentId IN (SELECT jobId FROM strategyExperiments WHERE "+where+")", args...)
	s.exec("UPDATE strategyOptimizations SET summaryJSON='' WHERE jobId IN (SELECT jobId FROM strategyExperiments WHERE "+where+")", args...)
	s.exec("UPDATE strategySourceEvents SET availability='tombstoned',summary='' WHERE availability='available' AND originKey IN (SELECT 'experiment:'||jobId FROM strategyExperiments WHERE "+where+")", args...)
	s.exec("UPDATE strategyExperimentRuns SET reportJSON='' WHERE experimentId IN (SELECT jobId FROM strategyExperiments WHERE "+where+")", args...)
	s.exec("UPDATE strategyExperiments SET frozenJSON='' WHERE "+where, args...)
}
