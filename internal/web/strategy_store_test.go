package web

import (
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/strategy"
)

func strategyFixture(t *testing.T) (*Store, StrategyContext, strategy.Scope) {
	t.Helper()
	s, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	project := stringOf(s.CreateProject("strategy fixture")["id"])
	return s, StrategyContext{ProjectID: project}, strategy.Scope{Kind: strategy.ProjectScope, ProjectID: project}
}
func strategyInput(body string) StrategyAssetInput {
	return StrategyAssetInput{Title: "Evidence first", Kind: strategy.DomainProcedure, Body: body, Applicability: strategy.Applicability{Profiles: []string{"core"}, DomainTags: []string{"operations"}}}
}
func strategyCheckError(t *testing.T, err error, status int) {
	t.Helper()
	var e *StrategyError
	if !errors.As(err, &e) || e.Status != status {
		t.Fatalf("expected safe strategy error %d, got %v", status, err)
	}
}
func createStrategyFixture(t *testing.T, s *Store, ctx StrategyContext, scope strategy.Scope, key, body string) StrategyMutationResult {
	t.Helper()
	r, err := s.CreateStrategyAsset(ctx, scope, key, strategyInput(body))
	if err != nil {
		t.Fatal(err)
	}
	return r
}
func enableStrategyFixture(t *testing.T, s *Store) {
	t.Helper()
	_, err := s.SetStrategySettings(StrategyContext{}, strategy.Scope{Kind: strategy.UserScope}, "enable", 0, StrategySettingsInput{MasterEnabled: true, ApplyEnabled: true, LearnEnabled: true, CorrectEnabled: true, Budget: strategy.DefaultBudget()})
	if err != nil {
		t.Fatal(err)
	}
}
func TestStrategyRepositoryVersionsBindingsAndIdempotency(t *testing.T) {
	s, ctx, scope := strategyFixture(t)
	first := createStrategyFixture(t, s, ctx, scope, "create", "First exact procedure.\r\n")
	again := createStrategyFixture(t, s, ctx, scope, "create", "First exact procedure.\r\n")
	if first != again {
		t.Fatal("duplicate created a new asset")
	}
	_, err := s.CreateStrategyAsset(ctx, scope, "create", strategyInput("different"))
	strategyCheckError(t, err, 409)
	twin := createStrategyFixture(t, s, ctx, scope, "different-key", "First exact procedure.\r\n")
	if twin.AssetID == first.AssetID {
		t.Fatal("title or body incorrectly treated as asset identity")
	}
	next, err := s.ReviseStrategyAsset(ctx, first.AssetID, "revise", 1, 1, strategyInput("Second procedure."))
	if err != nil || next.Revision != 2 {
		t.Fatal(next, err)
	}
	_, err = s.ReviseStrategyAsset(ctx, first.AssetID, "stale", 1, 1, strategyInput("lost update"))
	strategyCheckError(t, err, 409)
	for revision, body := range map[int64]string{1: "First exact procedure.\r\n", 2: "Second procedure."} {
		view, err := s.GetStrategyRevision(ctx, first.AssetID, revision)
		if err != nil || !view.Available || !view.SourcesAvailable || view.Value.Body != body || view.Value.Validate() != nil {
			t.Fatal("immutable bytes or source changed", view, err)
		}
	}
	ref := strategy.RevisionRef{AssetID: first.AssetID, Revision: 2, ContentHash: strategy.ContentHash("Second procedure.")}
	bound, err := s.BindStrategyAsset(ctx, scope, "adopt", StrategyBindingInput{Action: "adopt", Ref: ref})
	if err != nil || bound.BindingRevision != 1 {
		t.Fatal(bound, err)
	}
	againBound, err := s.BindStrategyAsset(ctx, scope, "adopt", StrategyBindingInput{Action: "adopt", Ref: ref})
	if err != nil || bound != againBound {
		t.Fatal("adoption replay changed projection", err)
	}
	ref.Revision = 1
	ref.ContentHash = strategy.ContentHash("First exact procedure.\r\n")
	bound, err = s.BindStrategyAsset(ctx, scope, "revert", StrategyBindingInput{Action: "revert", Ref: ref, ExpectedRevision: 1})
	if err != nil || bound.BindingRevision != 2 {
		t.Fatal(bound, err)
	}
	binding, err := s.GetStrategyBinding(ctx, scope, first.AssetID)
	if err != nil || binding.Revision != 1 || !binding.Enabled {
		t.Fatal(binding, err)
	}
	page, err := s.StrategyLineage(ctx, first.AssetID, 0, 50)
	if err != nil || len(page.Edges) != 6 {
		t.Fatal("revision/adoption lineage incomplete", len(page.Edges), err)
	}
	// The first version's parent cannot point forward, and the DB rejects edits.
	_, err = s.AddStrategyLineage(ctx, first.AssetID, "bad-edge", revisionNode(first.AssetID, 1), revisionNode(first.AssetID, 2), "supersedes")
	strategyCheckError(t, err, 400)
	for _, query := range []string{"UPDATE strategyRevisions SET verification='fixture_validated'", "DELETE FROM strategyRevisions", "UPDATE strategyRevisionContent SET body='tampered'", "DELETE FROM strategyRevisionSources", "UPDATE strategyLineageEdges SET relation='tested_by'"} {
		if _, err = s.db.Exec(query); err == nil {
			t.Fatal("immutable contract bypassed", query)
		}
	}
}
func TestStrategyRepositoryScopeSecretsAndTombstones(t *testing.T) {
	s, a, scope := strategyFixture(t)
	other := stringOf(s.CreateProject("other")["id"])
	b := StrategyContext{ProjectID: other}
	first := createStrategyFixture(t, s, a, scope, "private", "Project-only method.")
	_, err := s.GetStrategyRevision(b, first.AssetID, 1)
	strategyCheckError(t, err, 404)
	_, err = s.ListStrategyAssets(b, scope, "", 50)
	strategyCheckError(t, err, 404)
	for i, body := range []string{"token=synthetic-private-value", "-----BEGIN PRIVATE KEY-----\nprivate\n-----END PRIVATE KEY-----", "https://name:password@example.invalid"} {
		_, err = s.CreateStrategyAsset(a, scope, fmt.Sprint("secret-", i), strategyInput(body))
		strategyCheckError(t, err, 400)
	}
	global := createStrategyFixture(t, s, a, strategy.Scope{Kind: strategy.UserScope}, "global", "User-confirmed general procedure.")
	if _, err = s.GetStrategyRevision(b, global.AssetID, 1); err != nil {
		t.Fatal("explicitly global body unavailable", err)
	}
	// A project binding on a global asset is hidden from another project.
	_, err = s.BindStrategyAsset(a, scope, "project-adoption", StrategyBindingInput{Action: "adopt", Ref: strategy.RevisionRef{AssetID: global.AssetID, Revision: 1, ContentHash: strategy.ContentHash("User-confirmed general procedure.")}})
	if err != nil {
		t.Fatal(err)
	}
	page, err := s.StrategyLineage(b, global.AssetID, 0, 50)
	if err != nil || !page.Redacted || strings.Contains(jsonText(page), a.ProjectID) {
		t.Fatal("cross-project lineage leaked", page, err)
	}
	if _, err = s.ForgetStrategySource(b, first.SourceID, "foreign-revoke", true); err == nil {
		t.Fatal("foreign source revoked")
	}
	if _, err = s.ForgetStrategySource(a, first.SourceID, "revoke", true); err != nil {
		t.Fatal(err)
	}
	view, err := s.GetStrategyRevision(a, first.AssetID, 1)
	if err != nil || view.SourcesAvailable {
		t.Fatal("source revocation not visible", err)
	}
	if _, err = s.BindStrategyAsset(a, scope, "cannot-adopt", StrategyBindingInput{Action: "adopt", Ref: view.Value.Ref}); err == nil {
		t.Fatal("adopted missing provenance")
	}
	if _, err = s.DeleteStrategyAsset(a, first.AssetID, "delete", 1); err != nil {
		t.Fatal(err)
	}
	view, err = s.GetStrategyRevision(a, first.AssetID, 1)
	if err != nil || view.Available || view.Value.Body != "" || len(view.Value.Applicability.DomainTags) != 0 || view.Asset.Title != "" || view.Value.Ref.ContentHash != strategy.ContentHash("Project-only method.") {
		t.Fatal("deletion did not erase content and preserve fingerprint", view, err)
	}
}
func TestStrategyRepositoryTransactionRollbackAndConcurrentCAS(t *testing.T) {
	s, ctx, scope := strategyFixture(t)
	if _, err := s.db.Exec("CREATE TRIGGER fail_strategy_event BEFORE INSERT ON strategyEvents BEGIN SELECT RAISE(ABORT,'fixture write failure'); END"); err != nil {
		t.Fatal(err)
	}
	_, err := s.CreateStrategyAsset(ctx, scope, "atomic", strategyInput("Must roll back."))
	strategyCheckError(t, err, 500)
	for _, table := range []string{"strategyAssets", "strategyRevisions", "strategySourceEvents", "strategyLineageEdges", "strategyReceipts"} {
		if integer(s.row("SELECT COUNT(*) AS n FROM " + table)["n"]) != 0 {
			t.Fatal("partial transaction survived", table)
		}
	}
	s.db.Exec("DROP TRIGGER fail_strategy_event")
	first := createStrategyFixture(t, s, ctx, scope, "atomic", "Initial method.")
	var successes atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, err := s.ReviseStrategyAsset(ctx, first.AssetID, fmt.Sprint("race-", i), 1, 1, strategyInput(fmt.Sprint("Candidate ", i)))
			if err == nil {
				successes.Add(1)
			} else {
				var e *StrategyError
				if !errors.As(err, &e) || e.Status != 409 {
					t.Error(err)
				}
			}
		}(i)
	}
	wg.Wait()
	if successes.Load() != 1 {
		t.Fatal("CAS lost an edit", successes.Load())
	}
	events, err := s.PendingStrategyEvents(ctx, 0, 50)
	if err != nil || len(events) != 2 {
		t.Fatal("outbox did not commit with revisions", events, err)
	}
	if _, err = s.AcknowledgeStrategyEvent(ctx, int64(integer(events[0]["seq"]))); err != nil {
		t.Fatal(err)
	}
	events, err = s.PendingStrategyEvents(ctx, 0, 50)
	if err != nil || len(events) != 1 {
		t.Fatal("acknowledgement lost", events, err)
	}
}
func TestStrategySettingsDefaultInheritanceAndEpoch(t *testing.T) {
	s, ctx, scope := strategyFixture(t)
	value, err := s.GetStrategySettings(ctx, scope)
	if err != nil || value.Revision != 0 || value.MasterEnabled {
		t.Fatal(value, err)
	}
	enableStrategyFixture(t, s)
	effective, err := s.EffectiveStrategySettings(ctx)
	if err != nil || !effective.Settings.LearnEnabled || effective.GlobalEpoch != 1 || effective.ProjectEpoch != 0 {
		t.Fatal(effective, err)
	}
	input := StrategySettingsInput{MasterEnabled: true, ApplyEnabled: true, LearnEnabled: false, Budget: strategy.DefaultBudget()}
	input.Budget.MaxAdditionalTokens = 500
	if _, err = s.SetStrategySettings(ctx, scope, "project-settings", 0, input); err != nil {
		t.Fatal(err)
	}
	effective, err = s.EffectiveStrategySettings(ctx)
	if err != nil || effective.Settings.LearnEnabled || effective.Settings.Budget.MaxAdditionalTokens != 500 || effective.ProjectEpoch != 1 {
		t.Fatal(effective, err)
	}
	_, err = s.SetStrategySettings(ctx, scope, "stale-settings", 0, input)
	strategyCheckError(t, err, 409)
	input.Budget.MaxAdditionalTokens = 100001
	_, err = s.SetStrategySettings(ctx, scope, "excessive", 1, input)
	strategyCheckError(t, err, 400)
}

func TestStrategyDisableDoesNotInventAdoption(t *testing.T) {
	s, ctx, scope := strategyFixture(t)
	first := createStrategyFixture(t, s, ctx, scope, "asset", "Bounded method")
	ref := strategy.RevisionRef{AssetID: first.AssetID, Revision: 1, ContentHash: strategy.ContentHash("Bounded method")}
	if _, err := s.BindStrategyAsset(ctx, scope, "on", StrategyBindingInput{Action: "adopt", Ref: ref}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.BindStrategyAsset(ctx, scope, "off", StrategyBindingInput{Action: "disable", Ref: ref, ExpectedRevision: 1}); err != nil {
		t.Fatal(err)
	}
	if integer(s.row("SELECT COUNT(*) AS n FROM strategyLineageEdges WHERE relation='adopted_as'")["n"]) != 1 {
		t.Fatal("disable falsely recorded an adoption")
	}
	for _, query := range []string{"UPDATE strategyEvents SET actor='model'", "DELETE FROM strategyEvents", "UPDATE strategySourceEvents SET contentHash='made-up'", "DELETE FROM strategySourceEvents"} {
		if _, err := s.db.Exec(query); err == nil {
			t.Fatal("audit/source mutation permitted", query)
		}
	}
}

func TestStrategyContextCannotBeDecodedAndCorruptContentCannotBeAdopted(t *testing.T) {
	ctx := strategyDecode[StrategyContext](`{"ProjectID":"untrusted-project","projectId":"untrusted-project"}`)
	if ctx.ProjectID != "" {
		t.Fatal("untrusted JSON selected a project")
	}
	s, ctx, scope := strategyFixture(t)
	first := createStrategyFixture(t, s, ctx, scope, "asset", "Exact verified bytes")
	s.db.Exec("DELETE FROM strategyRevisionContent WHERE assetId=?", first.AssetID)
	s.db.Exec("INSERT INTO strategyRevisionContent VALUES(?,1,?,?)", first.AssetID, "Corrupted replacement", jsonText(strategyInput("irrelevant").Applicability))
	_, err := s.GetStrategyRevision(ctx, first.AssetID, 1)
	strategyCheckError(t, err, 500)
	_, err = s.BindStrategyAsset(ctx, scope, "adopt-corruption", StrategyBindingInput{Action: "adopt", Ref: strategy.RevisionRef{AssetID: first.AssetID, Revision: 1, ContentHash: strategy.ContentHash("Exact verified bytes")}})
	strategyCheckError(t, err, 500)
	if integer(s.row("SELECT COUNT(*) AS n FROM strategyBindings")["n"]) != 0 {
		t.Fatal("corrupted revision adopted")
	}
}
