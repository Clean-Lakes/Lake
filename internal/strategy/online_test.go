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
