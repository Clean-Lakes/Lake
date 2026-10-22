package strategy

// SnapshotProgress uses fixed host checks, never a model's claimed improvement.
// Rewording, a new revision/hash or a fresh evidence ID alone is not progress.
func SnapshotProgress(before, after FixtureEvaluation, beforeViolations, afterViolations int) bool {
	if after.Status == "not_evaluated" || afterViolations > 0 || afterViolations > beforeViolations {
		return false
	}
	for _, key := range []string{"boundary", "runtime_completed", "valid_output", "evidence"} {
		if before.Checks[key] && !after.Checks[key] {
			return false
		}
	}
	old, next := 0, 0
	for key, passed := range before.Checks {
		if passed {
			old++
		}
		if after.Checks[key] {
			next++
		}
	}
	return next > old
}
