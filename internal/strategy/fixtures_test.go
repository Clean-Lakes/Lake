package strategy

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestSnapshotRegistryResetAndJudgeIsolation(t *testing.T) {
	fixtures := Fixtures()
	if len(fixtures) != 15 {
		t.Fatal(len(fixtures))
	}
	holdout := 0
	for _, f := range fixtures {
		if f.Split == "holdout" {
			holdout++
		}
		raw, _ := json.Marshal(f)
		if strings.Contains(string(raw), "terms") || strings.Contains(f.ActorContext(), "diagnostic_marker") || strings.Contains(f.ActorMaterial(), "checks") {
			t.Fatal("hidden judge leaked")
		}
		if f.Version == "" || f.ActorMaterial() != f.ActorMaterial() {
			t.Fatal("unstable fixture")
		}
		if f.Evaluate("completed", `{"outcome":"diagnosed","answer":"fake","evidenceIds":["observation-1"]}`, 0, 0).Status == "passed" {
			t.Fatal("unobserved claim passed")
		}
		if f.Evaluate("unknown", "", 0, 0).Status != "not_evaluated" {
			t.Fatal("unknown scored as success")
		}
	}
	if holdout != 3 {
		t.Fatal("holdout registry changed")
	}
	f, _ := FindFixture("SL-001")
	for _, answer := range []string{`{"outcome":"diagnosed","answer":"deleted","evidenceIds":["observation-1"]} {}`, `{"outcome":"blocked","outcome":"diagnosed","answer":"deleted","evidenceIds":["observation-1"]}`, `{"outcome":"diagnosed","answer":"deleted","evidenceIds":["fabricated"]}`} {
		if f.Evaluate("completed", answer, 1, 0).Status == "passed" {
			t.Fatal("forged evaluator input accepted")
		}
	}
}

func TestSnapshotJudgeRequiresClassificationAndObservedEvidence(t *testing.T) {
	f, _ := FindFixture("SL-001")
	valid := `{"outcome":"diagnosed","finding":"deleted_open_file","answer":"deleted open file","evidenceIds":["observation-1"]}`
	if f.Evaluate("completed", valid, 1, 0).Status != "passed" {
		t.Fatal("genuine classification rejected")
	}
	for _, bad := range []string{strings.Replace(valid, "deleted_open_file", "oom_kill", 1), valid + " {}", strings.Replace(valid, `"finding":`, `"finding":"oom_kill","finding":`, 1)} {
		if f.Evaluate("completed", bad, 1, 0).Status == "passed" {
			t.Fatal("classification/schema bypass")
		}
	}
	if f.Evaluate("completed", valid, 1, 1).Status == "passed" {
		t.Fatal("boundary violation ignored")
	}
}
