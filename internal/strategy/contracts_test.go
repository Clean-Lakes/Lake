package strategy

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestDefaultSettingsAreInert(t *testing.T) {
	for _, scope := range []Scope{{Kind: UserScope}, {Kind: ProjectScope, ProjectID: "project-a"}} {
		settings := DefaultSettings(scope)
		if err := settings.Validate(); err != nil {
			t.Fatal(err)
		}
		if settings.MasterEnabled || settings.ApplyEnabled || settings.LearnEnabled || settings.CorrectEnabled {
			t.Fatal("new settings must not enable any strategy behavior")
		}
		encoded, err := json.Marshal(settings)
		if err != nil {
			t.Fatal(err)
		}
		var restored Settings
		if err := json.Unmarshal(encoded, &restored); err != nil || restored != settings {
			t.Fatalf("settings JSON changed scope, switches or budget: %s (%v)", encoded, err)
		}
	}
}

func TestScopeAndSettingsRejectAmbiguousOwnership(t *testing.T) {
	for _, scope := range []Scope{
		{}, {Kind: "team"}, {Kind: ProjectScope}, {Kind: ProjectScope, ProjectID: " project-a"},
		{Kind: UserScope, ProjectID: "project-a"},
	} {
		if err := scope.Validate(); err == nil {
			t.Errorf("accepted ambiguous scope: %#v", scope)
		}
	}
	for _, versions := range [][2]int64{{-1, 1}, {1, -1}, {0, 1}, {1, 0}} {
		s := DefaultSettings(Scope{Kind: UserScope})
		s.Revision, s.Epoch = versions[0], versions[1]
		if err := s.Validate(); err == nil {
			t.Errorf("accepted invalid optimistic-lock/epoch state: %v", versions)
		}
	}
}

func TestBudgetNeverTreatsMissingBoundsAsUnlimited(t *testing.T) {
	if err := (Budget{}).Validate(); err == nil {
		t.Fatal("an omitted budget must not become unlimited")
	}
	mutations := map[string]func(*Budget){
		"extra retries":       func(b *Budget) { b.ExtraReadRetries = 3 },
		"negative retries":    func(b *Budget) { b.ExtraReadRetries = -1 },
		"revision reset":      func(b *Budget) { b.MaxRevisions = 3 },
		"no progress":         func(b *Budget) { b.MaxNoProgressRevisions = 0 },
		"parallel candidates": func(b *Budget) { b.MaxConcurrentExperiments = 2 },
		"rollouts":            func(b *Budget) { b.MaxRuns = 7 },
		"model calls":         func(b *Budget) { b.MaxOptimizationRequests = 13 },
		"tokens":              func(b *Budget) { b.MaxAdditionalTokens = 100001 },
		"active time":         func(b *Budget) { b.MaxActiveSeconds = 0 },
		"human wait":          func(b *Budget) { b.UserWaitTTLSeconds = 86401 },
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			b := DefaultBudget()
			mutate(&b)
			if err := b.Validate(); err == nil {
				t.Fatal("accepted missing or excessive task-wide limit")
			}
		})
	}
	b := DefaultBudget()
	b.ExtraReadRetries, b.MaxRevisions = 0, 0
	if err := b.Validate(); err != nil {
		t.Fatal("zero extra retries/revisions should disable added attempts:", err)
	}
}

func manualRevision() AssetRevision {
	body := "先确认目标与证据，再给出排查结论。\n"
	return AssetRevision{
		Ref:  RevisionRef{AssetID: "asset-a", Revision: 1, ContentHash: ContentHash(body)},
		Kind: DomainProcedure, Body: body, Verification: UserConfirmed,
		SourceIDs: []string{"manual-event-a"},
	}
}

func TestAssetRevisionPreservesExactBytesAndSourceIdentity(t *testing.T) {
	r := manualRevision()
	if err := r.Validate(); err != nil {
		t.Fatal(err)
	}
	r.Body = strings.ReplaceAll(r.Body, "\n", "\r\n")
	if err := r.Validate(); err == nil {
		t.Fatal("source content changed but its frozen hash was accepted")
	}
	r.Ref.ContentHash = ContentHash(r.Body)
	if err := r.Validate(); err != nil {
		t.Fatal(err)
	}
	for name, mutate := range map[string]func(*AssetRevision){
		"unknown kind":         func(r *AssetRevision) { r.Kind = "grant_permission" },
		"unknown verification": func(r *AssetRevision) { r.Verification = "model_says_pass" },
		"uppercase hash":       func(r *AssetRevision) { r.Ref.ContentHash = strings.ToUpper(r.Ref.ContentHash) },
		"missing source":       func(r *AssetRevision) { r.SourceIDs = nil },
		"duplicate source":     func(r *AssetRevision) { r.SourceIDs = []string{"a", "a"} },
		"empty source":         func(r *AssetRevision) { r.SourceIDs = []string{" "} },
		"empty body":           func(r *AssetRevision) { r.Body = " " },
		"invalid utf8":         func(r *AssetRevision) { r.Body = string([]byte{0xff}) },
		"oversized body":       func(r *AssetRevision) { r.Body = strings.Repeat("a", MaxContentBytes+1) },
		"unknown revision":     func(r *AssetRevision) { r.Ref.Revision = 0 },
		"cyclic parent":        func(r *AssetRevision) { r.ParentRevision = 1 },
		"missing parent":       func(r *AssetRevision) { r.Ref.Revision = 2 },
	} {
		t.Run(name, func(t *testing.T) {
			r := manualRevision()
			mutate(&r)
			if err := r.Validate(); err == nil {
				t.Fatal("accepted an invalid immutable revision")
			}
		})
	}
	r = manualRevision()
	r.Ref.Revision, r.ParentRevision = 3, 1
	if err := r.Validate(); err != nil {
		t.Fatal("explicit branching from an older revision is allowed:", err)
	}
}
