package web

import "time"

// Shared by the active natural-memory batch worker and foreground admission.
// Caller holds messageMu. Cancel the provider and revoke its lease without
// waiting for network teardown. The active marker stays until the call exits.
func (b *Server) PauseMemoryExtractionForForeground() {
	if b.memoryCancel == nil {
		return
	}
	b.memoryCancel()
	b.Store.update(func() any {
		for _, item := range b.memoryBatchJobs {
			b.Store.exec("UPDATE projectMemoryJobs SET status='queued',attempts=max(0,attempts-1),nextAttemptAtMs=?,leaseToken='',leaseOwner='',leaseUntilMs=0,lastErrorCode='foreground_preempted',updatedAt=? WHERE jobId=? AND leaseToken=? AND status='running'", time.Now().Add(2*time.Second).UnixMilli(), now(), item.Job["jobId"], item.Job["leaseToken"])
		}
		b.Store.exec("UPDATE projectMemoryJobs SET status='queued',attempts=max(0,attempts-1),nextAttemptAtMs=?,leaseToken='',leaseOwner='',leaseUntilMs=0,lastErrorCode='foreground_preempted',updatedAt=? WHERE jobId=? AND leaseToken=? AND status='running'", time.Now().UnixMilli(), now(), b.memoryJobID, b.memoryLease)
		return nil
	})
}
