package ai

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/strategy"
)

func strategyProviderFixture(value strategy.AssetRevision, epoch *atomic.Int64) StrategyProvider {
	return func(_ context.Context, _ string, _ strategy.SelectionQuery, frozen *strategy.Selection) (strategy.ResolvedSelection, error) {
		current := epoch.Load()
		if frozen != nil && frozen.GlobalEpoch != current {
			return strategy.ResolvedSelection{}, errors.New("revoked")
		}
		return strategy.ResolvedSelection{Selection: strategy.Selection{GlobalEpoch: current, SettingsRevision: 1, Selected: []strategy.RevisionRef{value.Ref}, Omitted: []strategy.OmittedAsset{}}, Assets: []strategy.AssetRevision{value}}, nil
	}
}
func TestStrategyAssetsActualRequestManifestAndNoAuthorityChange(t *testing.T) {
	const body = "Prefer a concise evidence table.\nTreat outcomes separately from hypotheses."
	value := strategy.AssetRevision{Ref: strategy.RevisionRef{AssetID: "asset-report", Revision: 2, ContentHash: strategy.ContentHash(body)}, ParentRevision: 1, Kind: strategy.ReportGuidance, Body: body, Verification: strategy.UserConfirmed, SourceIDs: []string{"manual-source"}}
	var e *Engine
	var observed strategy.PromptManifest
	m, close := fakeModel(t, func(_ int, request map[string]any) any {
		observed = readPromptManifest(t, e, "case")
		sys := str(obj(arr(request["messages"])[0])["content"])
		if !strings.Contains(sys, "historical strategy data") || !strings.Contains(sys, "concise evidence table") || !strings.Contains(sys, readPrompt("identity-and-permissions")) {
			t.Error("missing strategy or fixed identity")
		}
		if len(observed.SelectedAssets) != 1 || observed.SelectedAssets[0] != value.Ref || !hasPromptSource(observed, "adopted-assets") || observed.Epoch != 3 {
			t.Error(observed)
		}
		expected, _ := promptFingerprint([]string{sys})
		if observed.SystemHash != expected {
			t.Error("manifest did not describe dispatched body")
		}
		return response("Done.")
	})
	defer close()
	e = engineFor(t, m, nil)
	var epoch atomic.Int64
	epoch.Store(3)
	e.Strategies = strategyProviderFixture(value, &epoch)
	c := Config{Model: m, Profile: "core", Runtime: "local"}
	baseTools := js(Catalog(c.Profile))
	baseFixed := composePrompt(c).LayerHash(strategy.FixedRules)
	if err := e.Chat(context.Background(), "case", "Use the provided instructions.", nil); err != nil {
		t.Fatal(err)
	}
	raw, _ := observed.CanonicalJSON()
	if strings.Contains(string(raw), body) || strings.Contains(string(raw), "manual-source") {
		t.Fatal("manifest contains raw source")
	}
	history, _ := e.History("case")
	if strings.Contains(history[0].Content, "concise evidence table") {
		t.Fatal("request-only assets polluted persistent system history")
	}
	if js(Catalog(c.Profile)) != baseTools || composePrompt(c).LayerHash(strategy.FixedRules) != baseFixed {
		t.Fatal("asset changed authoritative contracts")
	}
	s, _ := e.get("case")
	s.mu.Lock()
	frozen := s.state.PromptBaseline.Strategy
	s.mu.Unlock()
	if frozen == nil || frozen.Selected[0] != value.Ref {
		t.Fatal("turn selection not persisted")
	}
}
func TestStrategyRevocationBeforeToolPreventsExecutionAndRedispatch(t *testing.T) {
	var e *Engine
	var epoch atomic.Int64
	epoch.Store(1)
	var requests atomic.Int32
	m, close := fakeModel(t, func(_ int, _ map[string]any) any {
		requests.Add(1)
		epoch.Add(1)
		return response("", Call{ID: "stale-tool", Name: "todo_write", Arguments: `{"todos":[{"content":"should never execute","status":"pending"}]}`})
	})
	defer close()
	e = engineFor(t, m, nil)
	body := "Use bounded evidence."
	e.Strategies = strategyProviderFixture(strategy.AssetRevision{Ref: strategy.RevisionRef{AssetID: "a", Revision: 1, ContentHash: strategy.ContentHash(body)}, Body: body}, &epoch)
	if err := e.Chat(context.Background(), "case", "Inspect.", nil); err == nil {
		t.Fatal("revoked turn completed")
	}
	view, _ := e.Snapshot("case")
	if len(view.Todos) != 0 || requests.Load() != 1 {
		t.Fatal("stale model executed a tool or retried")
	}
}
func TestStrategyDuplicateLoadedSkillAndInputBudget(t *testing.T) {
	body := "A multi-line procedure.\nRead fresh evidence."
	value := strategy.AssetRevision{Ref: strategy.RevisionRef{AssetID: "a", Revision: 1, ContentHash: strategy.ContentHash(body)}, Body: body}
	m := Model{URL: "http://127.0.0.1:1/v1/chat/completions", Name: "fixture", Protocol: "openai", ContextWindow: 64000, MaxOutput: 1024}
	e := engineFor(t, m, nil)
	var epoch atomic.Int64
	epoch.Store(1)
	e.Strategies = strategyProviderFixture(value, &epoch)
	s, _ := e.get("case")
	s.mu.Lock()
	s.state.PromptBaseline = &strategy.PromptBaseline{}
	c := s.state.Config
	s.mu.Unlock()
	d := adkTurnDriver{engine: e, session: s, config: &c}
	history := []Message{{Role: "system", Content: Prompt(c)}, {Role: "tool", Name: "load_skill", Content: js(map[string]any{"content": body})}}
	result, _, selection, err := d.strategyRequest(context.Background(), history, nil, nil)
	if err != nil || len(selection.Selected) != 0 || selection.Omitted[0].Reason != "duplicate_context" || result[0].Content != history[0].Content {
		t.Fatal(selection, err)
	}
	c.Model.ContextWindow = 1
	_, _, selection, err = d.strategyRequest(context.Background(), history[:1], nil, nil)
	if err != nil || len(selection.Selected) != 0 || selection.Omitted[0].Reason != "input_budget" {
		t.Fatal(selection, err)
	}
}
