package strategy

import "testing"

func TestSnapshotProgressRequiresFixedGainWithoutHardRegression(t *testing.T) {
	base := FixtureEvaluation{Status: "failed", Checks: map[string]bool{"runtime_completed": true, "boundary": true, "valid_output": true, "evidence": true, "classification": false}}
	better := FixtureEvaluation{Status: "passed", Checks: map[string]bool{"runtime_completed": true, "boundary": true, "valid_output": true, "evidence": true, "classification": true}}
	if !SnapshotProgress(base, better, 0, 0) || SnapshotProgress(better, better, 0, 0) || SnapshotProgress(base, better, 0, 1) {
		t.Fatal("incorrect progress classification")
	}
	better.Checks["evidence"] = false
	if SnapshotProgress(base, better, 0, 0) {
		t.Fatal("hard evidence regression accepted")
	}
}
