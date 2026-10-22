package ai

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/strategy"
)

func TestStrategyUnavailableBeforeInjectionDoesNotBlockToolsOrFinalAnswer(t *testing.T) {
	var e *Engine
	var calls atomic.Int32
	m, close := fakeModel(t, func(n int, request map[string]any) any {
		calls.Add(1)
		if strings.Contains(js(request["tools"]), onlineRevisionTool) {
			t.Error("ordinary turn registered correction tool")
		}
		if n == 1 {
			return response("", Call{ID: "ordinary-tool", Name: "todo_write", Arguments: `{"todos":[{"content":"inspect evidence","status":"completed"}]}`})
		}
		manifest := readPromptManifest(t, e, "case")
		if len(manifest.SelectedAssets) != 0 || len(manifest.OmittedAssets) != 1 || manifest.OmittedAssets[0].Reason != "asset_service_unavailable" {
			t.Error("degraded selection diagnostic missing", manifest.OmittedAssets)
		}
		return response("Task completed from current evidence.")
	})
	defer close()
	e = engineFor(t, m, nil)
	e.Strategies = func(context.Context, string, strategy.SelectionQuery, *strategy.Selection) (strategy.ResolvedSelection, error) {
		return strategy.ResolvedSelection{}, errors.New("private backend diagnostic must not reach model")
	}
	if err := e.Chat(context.Background(), "case", "Inspect evidence.", nil); err != nil {
		t.Fatal(err)
	}
	view, _ := e.Snapshot("case")
	if view.Status != "completed" || calls.Load() != 2 || len(view.Todos) != 1 {
		t.Fatal("optional enrichment interrupted normal tool use", view.Status, calls.Load())
	}
}

func TestStrategyCancellationIsNotOptionalEnrichmentFailure(t *testing.T) {
	e := engineFor(t, Model{URL: "http://127.0.0.1:1", Name: "unused"}, nil)
	e.Strategies = func(ctx context.Context, _ string, _ strategy.SelectionQuery, _ *strategy.Selection) (strategy.ResolvedSelection, error) {
		return strategy.ResolvedSelection{}, ctx.Err()
	}
	s, _ := e.get("case")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := e.resolveTurnStrategies(ctx, s, s.state.Config); !errors.Is(err, context.Canceled) {
		t.Fatal("context cancellation was swallowed", err)
	}
}

func TestStrategyInvalidationOnlyCancelsUsedAssetsOrOnlineExperiments(t *testing.T) {
	for _, mode := range []string{"empty", "used_asset", "experiment"} {
		t.Run(mode, func(t *testing.T) {
			e := engineFor(t, Model{URL: "http://127.0.0.1:1", Name: "unused"}, nil)
			s, _ := e.get("case")
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			s.cancel = cancel
			selection := &strategy.Selection{Selected: []strategy.RevisionRef{}}
			if mode == "used_asset" {
				selection.Selected = []strategy.RevisionRef{{AssetID: "used", Revision: 1}}
			}
			s.state.PromptBaseline = &strategy.PromptBaseline{Strategy: selection}
			s.state.Config.StrategyCorrectEnabled = mode == "experiment"
			e.InvalidateStrategies("")
			if (ctx.Err() != nil) != (mode != "empty") {
				t.Fatal("incorrect invalidation", mode, ctx.Err())
			}
		})
	}
}
