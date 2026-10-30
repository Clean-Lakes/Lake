package strategy

import "testing"

func TestOnlineProgressRequiresClosingSameTrustedCheck(t *testing.T) {
	failure := OnlineObservation{CallID: "old", CheckHash: "check", TargetHash: "host", TrustedReadOnly: true, EvidenceHash: "failed"}
	sample := OnlineObservation{CallID: "new", CheckHash: "check", TargetHash: "host", TrustedReadOnly: true, EvidenceHash: "actual", Success: true}
	if !OnlineProgress(failure, sample) {
		t.Fatal("actual completed sample did not close the failed check")
	}
	for _, mutate := range []func(*OnlineObservation){func(o *OnlineObservation) { o.CheckHash = "different" }, func(o *OnlineObservation) { o.TargetHash = "another" }, func(o *OnlineObservation) { o.TrustedReadOnly = false }, func(o *OnlineObservation) { o.Success = false }, func(o *OnlineObservation) { o.EvidenceHash = "" }} {
		changed := sample
		mutate(&changed)
		if OnlineProgress(failure, changed) {
			t.Fatal("wording/target/hash alone established progress")
		}
	}
}

// Frozen historical evaluator; no production caller remains.
// A completed sample covers a known failed check only when its logical check
// and authorized target are unchanged. Novel text, IDs or timestamps do not
// prove progress. Alternate checks remain observations, not recovery proof.
func OnlineProgress(failed, sample OnlineObservation) bool {
	return !failed.Success && failed.TrustedReadOnly && sample.TrustedReadOnly &&
		sample.Success && failed.CheckHash != "" && failed.CheckHash == sample.CheckHash &&
		failed.TargetHash != "" && failed.TargetHash == sample.TargetHash && sample.EvidenceHash != ""
}
