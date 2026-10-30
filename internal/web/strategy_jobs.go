package web

// Called only while OpenStore owns the process lock. Retire pending work and
// retain unknown dispatch identities without returning anything to the queue.
func (s *Store) recoverStrategyJobs() {
	s.retireStrategyJobs()
}
