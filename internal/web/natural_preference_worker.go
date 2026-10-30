package web

import (
	"github.com/Clean-Lakes/Lake/internal/ai"
)

// Called with messageMu held. The single existing worker owns admission,
// dispatch, cancellation and settlement for both preference and project memory.
func (b *Server) processNaturalPreferenceJob(job Object, snapshot ai.MemoryTurnSnapshot) {
	b.processNaturalConsolidation(job, snapshot)
}

func (s *Store) execSafeNaturalYield(job Object) {
	s.update(func() any {
		s.exec("UPDATE projectMemoryJobs SET status='queued',attempts=max(0,attempts-1),leaseToken='',leaseOwner='',leaseUntilMs=0 WHERE jobId=? AND leaseToken=?", job["jobId"], job["leaseToken"])
		return nil
	})
}
