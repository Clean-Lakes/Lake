package legacystrategy

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestReuseEvaluationHoldoutSeparationAndNegativeControls(t *testing.T) {
	cases := ReuseEvaluationCases()
	if len(cases) != 24 {
		t.Fatal("pilot size")
	}
	groups := map[string]int{}
	ids := map[string]bool{}
	for _, c := range cases {
		groups[c.Category]++
		if ids[c.ID] || c.Fixture().Split != "holdout" || !c.Fixture().ReplayOnly() {
			t.Fatal("not independent holdout identity")
		}
		ids[c.ID] = true
		if strings.Contains(c.Body, c.Target) || strings.Contains(c.Body, c.Trace) || strings.Contains(c.Body, c.ID) {
			t.Fatal("asset memorizes holdout answer")
		}
		if c.Policy.Validate(c.Kind) != nil {
			t.Fatal("invalid frozen policy")
		}
		a := c.Fixture().ActorContext()
		if strings.Contains(a, "private_requirement") || strings.Contains(a, "negative_transfer") {
			t.Fatal("judge leaked")
		}
		answer := c.Target + " " + c.Trace + " " + strings.Join(c.Required, " ")
		raw, _ := json.Marshal(map[string]any{"outcome": "reported", "finding": "replay", "answer": answer, "evidenceIds": []string{"observation-1"}})
		if c.Evaluate("completed", string(raw), 0).Status != "passed" {
			t.Fatal("positive oracle")
		}
		if c.Evaluate("completed", string(raw), 1).Status == "passed" || c.Evaluate("failed", string(raw), 0).Status == "passed" {
			t.Fatal("failure hidden")
		}
		if len(c.Forbidden) > 0 {
			bad := strings.Replace(string(raw), answer, answer+c.Forbidden[0], 1)
			if c.Evaluate("completed", bad, 0).Status == "passed" {
				t.Fatal("negative transfer hidden")
			}
		}
	}
	for _, n := range groups {
		if n != 6 {
			t.Fatal("imbalanced task groups")
		}
	}
}

func TestReuseReplayRejectsAmbiguousProtocol(t *testing.T) {
	for _, bad := range []string{`{"outcome":"reported","finding":"replay","answer":"old","answer":"new","evidenceIds":["observation-1"]}`, `{"outcome":"reported","finding":"replay","answer":"ok","evidenceIds":["observation-1"]} {}`, `{"outcome":"reported","finding":"replay","answer":"ok","evidenceIds":["observation-1"],"verified":true}`} {
		if evaluateReplay("completed", bad, 0).Status == "passed" {
			t.Fatal("ambiguous replay protocol accepted")
		}
	}
}
