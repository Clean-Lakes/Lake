package web

const retiredMemoryV2Code = "memory_v2_retired"

// Caller owns the Store transaction. Quarantine old scheduling only: retain
// source/hash, attempts, charged usage and the original dispatch ledger verbatim.
// A running attempt is not proof that the provider did not execute it.
func (s *Store) retireMemoryV2JobsLocked() {
	s.exec(`UPDATE projectMemoryJobs SET status='blocked',lastErrorCode=?,
 leaseOwner='',leaseToken='',leaseUntilMs=0,updatedAt=?
 WHERE status IN ('queued','retry_wait','budget_wait','running') AND EXISTS
 (SELECT 1 FROM projectMemoryTurns t WHERE t.sequence=projectMemoryJobs.turnSequence AND
 CASE WHEN json_valid(t.snapshotJSON) THEN json_extract(t.snapshotJSON,'$.schemaVersion') ELSE NULL END=2)`, retiredMemoryV2Code, now())
}
