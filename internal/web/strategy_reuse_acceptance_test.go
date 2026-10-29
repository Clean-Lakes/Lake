//go:build !windows

package web

import (
	"context"
	"errors"
	"fmt"
	"github.com/Clean-Lakes/Lake/internal/ai"
	"github.com/Clean-Lakes/Lake/internal/strategy"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type reuseTrial struct {
	CaseID          string                   `json:"caseId"`
	Category        string                   `json:"category"`
	Repetition      int                      `json:"repetition"`
	Arm             string                   `json:"arm"`
	Status          string                   `json:"status"`
	AssetRef        strategy.RevisionRef     `json:"assetRef"`
	ExpectedApplied bool                     `json:"expectedApplied"`
	SelectionValid  bool                     `json:"selectionValid"`
	Result          ai.StrategyVariantResult `json:"result"`
}

func reuseSelectionValid(trial reuseTrial) bool {
	if len(trial.Result.Manifests) != 1 {
		return false
	}
	refs := trial.Result.Manifests[0].SelectedAssets
	if !trial.ExpectedApplied {
		return len(refs) == 0
	}
	return len(refs) == 1 && refs[0] == trial.AssetRef
}
func summarizeReuse(runs []reuseTrial) Object {
	pairs := map[string]map[string]reuseTrial{}
	groups := Object{}
	for _, r := range runs {
		key := r.CaseID + ":" + fmt.Sprint(r.Repetition)
		if pairs[key] == nil {
			pairs[key] = map[string]reuseTrial{}
		}
		pairs[key][r.Arm] = r
	}
	wins, regressions, ties, missing := 0, 0, 0, 0
	durationA, durationB, tokensA, tokensB := int64(0), int64(0), int64(0), int64(0)
	unknownUsage := 0
	for _, p := range pairs {
		a, b := p["baseline"], p["assets"]
		category := a.Category
		if category == "" {
			category = b.Category
		}
		if groups[category] == nil {
			groups[category] = Object{"wins": 0, "regressions": 0, "ties": 0, "missing": 0}
		}
		bucket := "ties"
		comparable := a.Status == "completed" && b.Status == "completed" && a.SelectionValid && b.SelectionValid && len(a.Result.Manifests) == 1 && len(b.Result.Manifests) == 1
		if comparable {
			am, bm := a.Result.Manifests[0], b.Result.Manifests[0]
			comparable = am.ModelConfigHash == bm.ModelConfigHash && am.ToolCatalogHash == bm.ToolCatalogHash && am.FixedRulesHash == bm.FixedRulesHash && am.BuiltinStrategyHash == bm.BuiltinStrategyHash && jsonText(am.SkillSnapshots) == jsonText(bm.SkillSnapshots)
		}
		if !comparable {
			bucket = "missing"
			missing++
		} else {
			ap, bp := a.Result.Evaluation.Status == "passed", b.Result.Evaluation.Status == "passed"
			if ap && !bp {
				bucket = "regressions"
				regressions++
			} else if !ap && bp {
				bucket = "wins"
				wins++
			} else {
				ties++
			}
			durationA += a.Result.DurationMs
			durationB += b.Result.DurationMs
			au, bu := a.Result.Usage, b.Result.Usage
			if au.InputKnown && au.OutputKnown && bu.InputKnown && bu.OutputKnown {
				tokensA += int64(au.Input + au.Output)
				tokensB += int64(bu.Input + bu.Output)
			} else {
				unknownUsage++
			}
		}
		g := object(groups[category])
		g[bucket] = integer(g[bucket]) + 1
	}
	decision := "inconclusive"
	if missing == 0 && regressions > 0 {
		decision = "regression_on_frozen_replays"
	} else if missing == 0 && wins > 0 {
		decision = "improvement_on_frozen_replays"
	} else if missing == 0 {
		decision = "no_difference_on_frozen_replays"
	}
	return Object{"paired": len(pairs), "wins": wins, "regressions": regressions, "ties": ties, "missing": missing, "groups": groups, "replayConclusion": decision, "generalBenefit": "inconclusive", "recommendation": "keep_opt_in_no_scope_expansion", "measuredDurationMs": Object{"baseline": durationA, "assets": durationB, "delta": durationB - durationA}, "knownUsageTokens": Object{"baseline": tokensA, "assets": tokensB, "delta": tokensB - tokensA, "pairsWithUnknownUsage": unknownUsage}, "costAmount": "unknown"}
}
func reusePilot(t *testing.T, model ai.Model, reps int, path string, meter *p8Meter) Object {
	t.Helper()
	cases := strategy.ReuseEvaluationCases()
	root := t.TempDir()
	if dir := os.Getenv("LAKE_R5_PRIVATE_RUN_DIR"); dir != "" {
		var e error
		root, e = os.MkdirTemp(dir, "reuse-r5-")
		if e != nil {
			t.Fatal("private acceptance directory unavailable")
		}
		_ = os.Chmod(root, 0700)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
	defer cancel()
	runs := []reuseTrial{}
	failures := 0
	stopReason := "completed"
	report := Object{"schemaVersion": 1, "sourceCommit": os.Getenv("LAKE_R5_SOURCE_COMMIT"), "mode": "same_model_daily_selector_readonly_replay", "status": "running", "providerKind": "real_configured_Dev_model", "model": model.Name, "protocol": model.Protocol, "modelRef": ai.ModelIdentity(model), "modelHash": experimentModelHash(model), "reasoningEffort": model.ReasoningEffort, "contextWindow": model.ContextWindow, "maxOutput": model.MaxOutput, "providerVersion": "capture_response_alias_only", "seed": "not_exposed", "casesHash": strategy.ContentHash(jsonText(cases)), "judgeVersion": "reuse-replay-rubric-v1", "sharedMemoryHash": strategy.ContentHash("empty"), "sharedSkillsHash": strategy.ContentHash("empty"), "onlineCorrection": false, "backgroundLearning": false, "backgroundRequests": 0, "automaticAdoption": false, "registeredTasks": len(cases), "plannedPairs": len(cases) * reps, "limits": Object{"providerRequests": 144, "conservativeTokens": 4000000, "perArmRequests": 1, "deadlineSeconds": 1200}, "limitations": []string{"24 constructed private-convention/replay tasks with shared development-authored rules; correlated, not an independent user field study.", "Fixed literal preference/fact checks, not full semantic quality or statistical significance.", "No live host diagnosis or recovery; no repeated writes. No price/rate supplied; amount unknown.", "Provider aliases can silently change; cannot assert immutable provider model weights.", "User correction burden and real-world review/rejection rates remain unmeasured; no default expansion."}}
	if meter == nil {
		report["providerKind"] = "deterministic_control"
	}
	save := func() {
		report["runs"] = runs
		report["summary"] = summarizeReuse(runs)
		if meter != nil {
			report["providerRequests"] = meter.requests
			report["tokensCharged"] = meter.tokens
			report["usageUnknown"] = meter.usageUnknown
			report["providerModels"] = meter.versions
		}
		p8Save(t, path, report, model.Key)
	}
	defer func() {
		if report["status"] == "running" {
			report["status"] = "interrupted"
		}
		save()
	}()
	for ci, c := range cases {
		s, e := OpenStore(filepath.Join(root, c.ID, "business"))
		if e != nil {
			t.Fatal("isolated reuse store unavailable")
		}
		project := stringOf(s.CreateProject(c.ID + " holdout")["id"])
		scope := strategy.Scope{Kind: strategy.ProjectScope, ProjectID: project}
		sc := StrategyContext{ProjectID: project}
		_, e = s.SetStrategySettings(StrategyContext{}, strategy.Scope{Kind: strategy.UserScope}, ident(), 0, StrategySettingsInput{MasterEnabled: true, ApplyEnabled: true, Budget: strategy.DefaultBudget()})
		if e != nil {
			t.Fatal(e)
		}
		input := StrategyAssetInput{Title: "Development-authored reviewed " + c.Category, Kind: c.Kind, Body: c.Body, Reuse: &c.Policy, Applicability: strategy.Applicability{Profiles: []string{"core"}}, ModelHash: ai.StrategyReuseModelHash(model), ToolHashes: map[string]string{"core": strategy.ContentHash(jsonText(ai.Catalog("core")))}}
		if c.Variant == "model_changed" {
			input.ModelHash = strategy.ContentHash("earlier-model")
		}
		if c.Variant == "tools_changed" {
			input.ToolHashes["core"] = strategy.ContentHash("earlier-catalog")
		}
		a, e := s.CreateStrategyAsset(sc, scope, ident(), input)
		if e != nil {
			t.Fatal(e)
		}
		v, e := s.GetStrategyRevision(sc, a.AssetID, 1)
		if e != nil {
			t.Fatal(e)
		}
		_, e = s.BindStrategyAsset(sc, scope, ident(), StrategyBindingInput{Action: "adopt", Ref: v.Value.Ref})
		if e != nil {
			t.Fatal(e)
		}
		parent, e := ai.New(filepath.Join(root, c.ID, "parent"), nil, nil)
		if e != nil {
			t.Fatal("isolated parent unavailable")
		}
		if meter != nil {
			meter.newJob()
		}
		for rep := 1; rep <= reps; rep++ {
			arms := []string{"baseline", "assets"}
			if (ci+rep)%2 == 0 {
				arms = []string{"assets", "baseline"}
			}
			for _, arm := range arms {
				tr := reuseTrial{CaseID: c.ID, Category: c.Category, Repetition: rep, Arm: arm, Status: "not_executed", AssetRef: v.Value.Ref, ExpectedApplied: arm == "assets" && c.ExpectedApplied}
				if ctx.Err() == nil {
					setting, e := s.GetStrategySettings(sc, scope)
					if e != nil {
						t.Fatal(e)
					}
					_, e = s.SetStrategySettings(sc, scope, ident(), setting.Revision, StrategySettingsInput{MasterEnabled: true, ApplyEnabled: arm == "assets", Budget: strategy.DefaultBudget()})
					if e != nil {
						t.Fatal(e)
					}
					reserves := 0
					armCtx, stop := context.WithTimeout(ctx, 45*time.Second)
					out := parent.RunStrategyVariant(armCtx, ai.StrategyVariantInput{RunID: ident(), Home: filepath.Join(root, c.ID, ident()), Fixture: c.Fixture(), Model: model, SharedContext: "Shared frozen Skills and project memory are empty.", Strategies: func(_ context.Context, _ string, q strategy.SelectionQuery, frozen *strategy.Selection) (strategy.ResolvedSelection, error) {
						return s.resolveStrategyBindings(sc, q, frozen, nil)
					}, Reserve: func(int64) error {
						reserves++
						if reserves > 1 {
							return errors.New("experiment_budget: one request per arm")
						}
						return nil
					}, Settle: func(int64, ai.Usage) error { return nil }, Safe: func(text string) bool { return ai.SafeMemoryContent(text, model) }})
					stop()
					out.Evaluation = c.Evaluate(out.Status, out.Answer, out.Violations)
					tr.Result = out
					tr.Status = out.Status
					tr.SelectionValid = reuseSelectionValid(tr)
					if tr.Status != "completed" {
						failures++
					} else {
						failures = 0
					}
					if failures >= 2 {
						stopReason = "two_runtime_failures"
						cancel()
					}
					if out.Violations > 0 || tr.Status == "completed" && !tr.SelectionValid {
						stopReason = "selection_or_boundary_failure"
						cancel()
					}
					if meter != nil && len(meter.versions) > 1 {
						stopReason = "provider_alias_changed"
						cancel()
					}
				}
				runs = append(runs, tr)
				save()
			}
			t.Logf("reuse %s pair %d recorded", c.ID, rep)
		}
		parent.Shutdown()
		s.Close()
	}
	report["status"] = "recorded"
	if ctx.Err() != nil {
		report["status"] = "stopped"
		if stopReason == "completed" {
			stopReason = "deadline_or_cancelled"
		}
	}
	report["stopReason"] = stopReason
	save()
	return report
}
func TestStrategyReusePilotEntryIsRetired(t *testing.T) {
	engine, err := ai.New(t.TempDir(), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer engine.Shutdown()
	requests := 0
	result := engine.RunStrategyVariant(context.Background(), ai.StrategyVariantInput{RunID: "old-pilot", Home: filepath.Join(t.TempDir(), "not-created"), Reserve: func(int64) error { requests++; return nil }})
	if result.Status != "retired" || result.ErrorCode != "strategy_execution_retired" || requests != 0 {
		t.Fatal("retired pilot ran", result)
	}
}

func TestR5ConfiguredDevModelPairedAcceptance(t *testing.T) {
	home := os.Getenv("LAKE_R5_DEV_MODEL_HOME")
	if home != "" {
		t.Fatal("R5 actor is retired; retain historical reports and use current scoped-memory acceptance instead")
	}
	if home == "" {
		t.Skip("explicit R5 Dev-model acceptance only")
	}
	real, e := filepath.EvalSymlinks(home)
	if e != nil || real != filepath.Clean(home) || filepath.Base(real) != ".lake-dev" {
		t.Fatal("explicit non-symlink Dev Home required")
	}
	expected := os.Getenv("LAKE_R5_SOURCE_COMMIT")
	actual, e := exec.Command("git", "rev-parse", "HEAD").Output()
	dirty, de := exec.Command("git", "status", "--porcelain").Output()
	if expected == "" || e != nil || de != nil || strings.TrimSpace(string(actual)) != expected || len(dirty) > 0 {
		t.Fatal("clean specified source required")
	}
	models := &Models{Home: real, Dir: filepath.Join(real, "web-agent")}
	model := models.Active()
	if model == nil || model.Protocol != "openai" {
		t.Fatal("configured Dev OpenAI model unavailable")
	}
	model.ContextWindow = 64000
	model.MaxOutput = 2048
	model.ReasoningEffort = ""
	if ai.ValidReasoningEffort(*model, "low") {
		model.ReasoningEffort = "low"
	}
	path := os.Getenv("LAKE_R5_REPORT")
	if path == "" || !filepath.IsAbs(path) {
		t.Fatal("private absolute report path required")
	}
	base := ai.HTTPClient
	meter := &p8Meter{base: http.DefaultTransport, endpoint: model.URL, versions: map[string]bool{}, started: time.Now(), maxRequests: 144, maxTokens: 4000000, maxDuration: 20 * time.Minute, journal: path + ".reservations"}
	if base.Transport != nil {
		meter.base = base.Transport
	}
	ai.HTTPClient = &http.Client{Transport: meter, Timeout: 50 * time.Second}
	defer func() { ai.HTTPClient = base }()
	reusePilot(t, *model, 3, path, meter)
}

func TestStrategyReuseComparisonDoesNotHideMissingOrRegression(t *testing.T) {
	manifest := strategy.PromptManifest{ModelConfigHash: "same", ToolCatalogHash: "same", FixedRulesHash: "same", BuiltinStrategyHash: "same", SelectedAssets: []strategy.RevisionRef{}}
	a := reuseTrial{CaseID: "case", Category: "negative_transfer", Repetition: 1, Arm: "baseline", Status: "completed", SelectionValid: true, Result: ai.StrategyVariantResult{Evaluation: strategy.FixtureEvaluation{Status: "passed"}, Manifests: []strategy.PromptManifest{manifest}}}
	b := a
	b.Arm = "assets"
	b.Result.Evaluation.Status = "failed"
	if integer(summarizeReuse([]reuseTrial{a, b})["regressions"]) != 1 {
		t.Fatal("negative transfer hidden")
	}
	b.Status = "failed"
	if integer(summarizeReuse([]reuseTrial{a, b})["missing"]) != 1 {
		t.Fatal("provider failure hidden")
	}
	b = a
	b.Arm = "assets"
	b.Result.Manifests = append([]strategy.PromptManifest{}, b.Result.Manifests...)
	b.Result.Manifests[0].ModelConfigHash = "changed"
	if integer(summarizeReuse([]reuseTrial{a, b})["missing"]) != 1 {
		t.Fatal("different models compared")
	}
}
