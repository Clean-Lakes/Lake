package ai

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/Clean-Lakes/Lake/internal/strategy"
)

type StrategyVariantInput struct {
	RunID, Home   string
	Fixture       strategy.Fixture
	Model         Model
	Asset         *strategy.AssetRevision
	SharedContext string
	// Host callbacks fence authorization and reserve the WHOLE experiment's budget.
	Reserve func(int64) error
	Settle  func(int64, Usage) error
	Guard   func() error
	Safe    func(string) bool
}
type StrategyVariantResult struct {
	Status     string                     `json:"status"`
	Answer     string                     `json:"answer"`
	RuntimeID  string                     `json:"runtimeId"`
	ResetHash  string                     `json:"resetHash"`
	ResetNonce string                     `json:"resetNonce"`
	Observed   int                        `json:"observed"`
	Violations int                        `json:"violations"`
	Requests   int                        `json:"requests"`
	Usage      Usage                      `json:"usage"`
	DurationMs int64                      `json:"durationMs"`
	Manifests  []strategy.PromptManifest  `json:"manifests"`
	Evaluation strategy.FixtureEvaluation `json:"evaluation"`
	ErrorCode  string                     `json:"errorCode,omitempty"`
}
type strategyExperimentRuntime struct {
	mu     sync.Mutex
	input  StrategyVariantInput
	path   string
	hash   string
	result StrategyVariantResult
}

func (r *strategyExperimentRuntime) catalog() []Tool {
	name := "read"
	if r.input.Fixture.Profile == "db-query-editor" {
		name = "execute_sql"
	}
	for _, t := range Catalog(r.input.Fixture.Profile) {
		if t.Name == name {
			return []Tool{t}
		}
	}
	return nil
}
func (r *strategyExperimentRuntime) invoke(call Call) (any, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	deny := func() (any, error) {
		r.result.Violations++
		return nil, errors.New("isolated fixture boundary: operation not executed")
	}
	if r.input.Guard != nil {
		if err := r.input.Guard(); err != nil {
			return nil, err
		}
	}
	if r.result.Observed >= 16 {
		return deny()
	}
	a, err := args(call)
	if err != nil {
		return deny()
	}
	allowed := false
	if r.input.Fixture.Profile == "db-query-editor" {
		allowed = call.Name == "execute_sql" && len(a) == 3 && a["asset_ref"] == "fixture-db" && a["schema"] == "fixture" && a["sql"] == "SELECT * FROM fixture_observations"
	} else {
		allowed = call.Name == "read" && len(a) == 1 && a["path"] == "/fixture/observations.json"
	}
	if !allowed || r.input.Fixture.ID == "SL-009" {
		return deny()
	}
	raw, err := os.ReadFile(r.path)
	if err != nil || strategy.ContentHash(string(raw)) != r.hash {
		return nil, errors.New("fixture reset verification failed")
	}
	r.result.Observed++
	var data map[string]any
	_ = json.Unmarshal(raw, &data)
	return data, nil
}

// RunStrategyVariant creates a fresh independent Engine/Home and enters the
// existing official ADK. The early private tool boundary has no host executor,
// bridge, extension store or arbitrary path access, even for forged tool calls.
func (e *Engine) RunStrategyVariant(ctx context.Context, in StrategyVariantInput) (out StrategyVariantResult) {
	start := time.Now()
	out.Status = "failed"
	out.ErrorCode = "setup_failed"
	defer func() {
		if recover() != nil {
			out.Status = "failed"
			out.ErrorCode = "variant_internal_error"
		}
		out.DurationMs = time.Since(start).Milliseconds()
		out.Evaluation = in.Fixture.Evaluate(out.Status, out.Answer, out.Observed, out.Violations)
	}()
	if !identifier.MatchString(in.RunID) || in.Model.Protocol != "openai" && in.Model.Protocol != "" {
		out.ErrorCode = "unsupported_model"
		return
	}
	if err := os.Mkdir(in.Home, 0700); err != nil {
		out.ErrorCode = "reset_failed"
		return
	}
	raw := in.Fixture.ActorMaterial()
	path := filepath.Join(in.Home, "observations.json")
	if os.WriteFile(path, []byte(raw), 0600) != nil {
		return
	}
	actual, err := os.ReadFile(path)
	if err != nil || string(actual) != raw {
		return
	}
	runtime := &strategyExperimentRuntime{input: in, path: path, hash: strategy.ContentHash(raw), result: StrategyVariantResult{ResetHash: strategy.ContentHash(raw), ResetNonce: in.RunID, Manifests: []strategy.PromptManifest{}}}
	child, err := New(filepath.Join(in.Home, "ai"), nil, nil)
	if err != nil {
		return
	}
	defer child.Shutdown()
	child.RuntimeDir = filepath.Join(in.Home, "adk")
	child.modelSlots = e.modelSlots
	child.childModelSlots = e.childModelSlots
	child.experiment = runtime
	if in.Asset != nil {
		asset := *in.Asset
		child.Strategies = func(_ context.Context, _ string, q strategy.SelectionQuery, _ *strategy.Selection) (strategy.ResolvedSelection, error) {
			if in.Guard != nil {
				if err := in.Guard(); err != nil {
					return strategy.ResolvedSelection{}, err
				}
			}
			return strategy.Resolve([]strategy.Candidate{{Value: asset}}, q, 8192), nil
		}
	}
	kind := "local"
	if in.Fixture.Domain == "database" {
		kind = "database"
	}
	if in.Fixture.Domain == "ssh" {
		kind = "ssh"
	}
	if in.Fixture.Domain == "redis" {
		kind = "redis"
	}
	if in.Fixture.Domain == "docker" {
		kind = "docker"
	}
	if err = child.Configure(in.RunID, Config{AssetRef: "fixture-db", Assets: []Asset{{ID: "fixture-db", Name: "Synthetic fixture", Kind: kind}}, Model: in.Model, Profile: in.Fixture.Profile, Runtime: "local", MaxSteps: 3, Permissions: &Permissions{}, UserPrompt: in.SharedContext}); err != nil {
		return
	}
	err = child.ExecuteTurn(ctx, in.RunID, TurnInput{UserText: in.Fixture.Prompt, Context: in.Fixture.ActorContext()})
	runtime.mu.Lock()
	out = runtime.result
	runtime.mu.Unlock()
	out.Status = "completed"
	if err != nil {
		out.Status = "failed"
		out.ErrorCode = "runtime_failed"
		if strings.Contains(err.Error(), "experiment_budget") {
			out.ErrorCode = "experiment_budget"
		}
		if strings.Contains(err.Error(), "context") {
			out.ErrorCode = "context_budget"
		}
		if ctx.Err() != nil {
			out.Status = "cancelled"
			out.ErrorCode = "cancelled"
		}
	}
	state, _ := child.get(in.RunID)
	if state != nil {
		state.mu.Lock()
		if state.state.Runtime != nil {
			out.RuntimeID = state.state.Runtime.SessionID
		}
		state.mu.Unlock()
	}
	history, _ := child.History(in.RunID)
	for _, m := range history {
		if m.Role == "assistant" && len(m.Calls) == 0 {
			out.Answer = m.Content
		}
		for _, call := range m.Calls {
			if call.Name != "read" && call.Name != "execute_sql" {
				out.Violations++
			}
		}
	}
	if len(out.Answer) > 16384 {
		out.Answer = ""
		out.Status = "failed"
		out.ErrorCode = "output_limit"
	}
	finalBytes, finalErr := os.ReadFile(path)
	if finalErr != nil || strategy.ContentHash(string(finalBytes)) != out.ResetHash || out.ResetHash != strategy.ContentHash(in.Fixture.ActorMaterial()) {
		out.Status = "failed"
		out.ErrorCode = "reset_failed"
	}
	return
}
