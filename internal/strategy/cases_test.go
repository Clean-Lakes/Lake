package strategy

import (
	"encoding/json"
	"io"
	"os"
	"testing"
)

// This checks the P0 fixture specification, not model performance or an
// executable environment. Evaluator checks must never enter actor context.
func TestP0CaseManifest(t *testing.T) {
	f, err := os.Open("testdata/cases.v1.json")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var spec struct {
		SchemaVersion int             `json:"schemaVersion"`
		Status        string          `json:"status"`
		Arms          []ExperimentArm `json:"arms"`
		Cases         []struct {
			ID               string   `json:"id"`
			Split            string   `json:"split"`
			Domain           string   `json:"domain"`
			Fixture          string   `json:"fixture"`
			Profile          string   `json:"profile"`
			Prompt           string   `json:"prompt"`
			ExpectedOutcome  string   `json:"expectedOutcome"`
			EvaluatorChecks  []string `json:"evaluatorChecks"`
			ForbiddenEffects []string `json:"forbiddenEffects"`
			ResetContract    string   `json:"resetContract"`
		} `json:"cases"`
	}
	decoder := json.NewDecoder(f)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&spec); err != nil {
		t.Fatal(err)
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		t.Fatal("case specification must contain exactly one JSON document")
	}
	if spec.SchemaVersion != SchemaVersion || spec.Status != "specified_not_implemented" {
		t.Fatal("P0 must not claim executable fixtures or completed evaluations")
	}
	if len(spec.Arms) != 3 || spec.Arms[0] != BaselineArm || spec.Arms[1] != AssetsArm || spec.Arms[2] != CorrectionArm {
		t.Fatal("baseline/asset/correction comparisons must remain separate")
	}
	ids, domains, splits, outcomes := map[string]bool{}, map[string]bool{}, map[string]int{}, map[string]bool{}
	for _, c := range spec.Cases {
		if c.ID == "" || ids[c.ID] || c.Fixture == "" || c.Prompt == "" || c.ResetContract == "" || len(c.EvaluatorChecks) == 0 {
			t.Fatalf("case %q lacks unique identity, reset contract, input or evaluator checks", c.ID)
		}
		if c.Split != "development" && c.Split != "holdout" {
			t.Fatalf("case %q has an undefined split", c.ID)
		}
		if c.ExpectedOutcome != "diagnosed" && c.ExpectedOutcome != "blocked" && c.ExpectedOutcome != "direct_answer" {
			t.Fatalf("case %q lacks an explicit task outcome", c.ID)
		}
		if c.Profile != "core" && c.Profile != "terminal2" && c.Profile != "db-query-editor" {
			t.Fatalf("case %q names an unavailable profile", c.ID)
		}
		for _, boundary := range []string{"unrequested_resource_mutation", "credential_read", "scope_expansion"} {
			found := false
			for _, forbidden := range c.ForbiddenEffects {
				found = found || forbidden == boundary
			}
			if !found {
				t.Errorf("case %q is missing boundary %q", c.ID, boundary)
			}
		}
		ids[c.ID], domains[c.Domain], outcomes[c.ExpectedOutcome] = true, true, true
		splits[c.Split]++
	}
	if len(ids) != 15 || splits["development"] != 12 || splits["holdout"] != 3 || len(outcomes) != 3 {
		t.Fatal("P0 requires 12 development/3 holdout cases including correct blocking and direct answers")
	}
	for _, domain := range []string{"disk", "service", "docker", "database", "ssh", "permission", "capability", "conversation", "security", "recovery", "progress", "scope", "redis", "kubernetes"} {
		if !domains[domain] {
			t.Errorf("missing case family: %s", domain)
		}
	}
}
