package web

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
	"github.com/Clean-Lakes/Lake/internal/strategy"
)

func (b *Server) executeOptimization(scope StrategyContext, job Object) {
	id, token := stringOf(job["id"]), stringOf(job["leaseToken"])
	stop := func(reason string) { _, _ = b.Store.finishOptimization(scope, id, token, reason) }
	row, err := strategyCall(b.Store, false, func() Object {
		b.Store.strategyCheckLease(scope, b.Store.strategyJob(scope, id), token)
		return b.Store.row("SELECT * FROM strategyExperiments WHERE jobId=?", id)
	})
	if err != nil || row == nil || row["frozenJSON"] == "" {
		stop("source_changed")
		return
	}
	frozen := strategyDecode[strategyExperimentFrozen](stringOf(row["frozenJSON"]))
	if !frozen.Optimization || strategy.ContentHash(stringOf(row["frozenJSON"])) != row["frozenHash"] || !b.strategySafeText(stringOf(row["frozenJSON"])) {
		stop("source_changed")
		return
	}
	model := b.Models.ResolveModelIdentity(frozen.ModelRef)
	if model == nil {
		stop("model_unavailable")
		return
	}
	model.ContextWindow = frozen.ContextWindow
	model.MaxOutput = frozen.MaxOutput
	model.ReasoningEffort = frozen.ReasoningEffort
	if model.Protocol != "openai" && model.Protocol != "" {
		stop("unsupported_model")
		return
	}
	runtime, err := b.Store.PrepareStrategyDispatch(scope, id, token)
	if err != nil {
		stop("awaiting_reconciliation")
		return
	}
	defer func() { _, _ = b.Store.ObserveStrategyDispatch(scope, id, runtime, "complete") }()
	_, _ = b.Store.ObserveStrategyDispatch(scope, id, runtime, "started")
	ctx, cancel := context.WithDeadline(b.Context, time.UnixMilli(int64(integer(job["expiresAtMs"]))))
	defer cancel()
	done, watchDone := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(watchDone)
		tick := time.NewTicker(250 * time.Millisecond)
		defer tick.Stop()
		for {
			select {
			case <-done:
				return
			case <-ctx.Done():
				return
			case <-tick.C:
				if b.experimentGuard(scope, id, token, frozen) != nil {
					cancel()
					return
				}
			}
		}
	}()
	defer func() { close(done); <-watchDone }()
	_, err = strategyCall(b.Store, true, func() bool {
		b.Store.strategyCheckLease(scope, b.Store.strategyJob(scope, id), token)
		b.Store.exec("UPDATE strategyOptimizations SET activationStartedMs=? WHERE jobId=?", time.Now().UnixMilli(), id)
		return true
	})
	if err != nil {
		stop("source_changed")
		return
	}
	root := filepath.Join(b.options.DataDir, "strategy-experiments")
	if os.MkdirAll(root, 0700) != nil {
		stop("reset_failed")
		return
	}
	for {
		if b.experimentGuard(scope, id, token, frozen) != nil {
			stop("source_changed")
			return
		}
		if ctx.Err() != nil {
			stop("budget_exhausted")
			return
		}
		o, e := strategyCall(b.Store, false, func() Object { return b.Store.row("SELECT * FROM strategyOptimizations WHERE jobId=?", id) })
		if e != nil || o == nil {
			stop("failed")
			return
		}
		stage := integer(o["stage"])
		if stage == 7 {
			b.finalizeOptimization(scope, id, token, frozen)
			return
		}
		if stage == 1 || stage == 3 {
			name := "propose"
			if stage == 3 {
				name = "synthesize"
			}
			candidate, code := b.optimizationModel(ctx, scope, id, token, name, frozen, *model)
			if code != "" {
				stop(code)
				return
			}
			if candidate == nil {
				stop("no_candidate")
				return
			}
			if strategy.ContentHash(candidate.Body) == frozen.Asset.Ref.ContentHash {
				stop("no_progress")
				return
			}
			if stage == 3 {
				first, _ := b.optimizationCandidate(id, "propose")
				if first == nil || candidate.Body == first.Body {
					stop("no_progress")
					return
				}
			}
		} else {
			index := map[int]int{0: 0, 2: 1, 4: 2, 5: 3, 6: 4}[stage]
			var asset *strategy.AssetRevision
			if stage == 2 || stage == 4 || stage == 6 {
				name := "propose"
				if stage != 2 {
					name = "synthesize"
				}
				asset, e = b.optimizationAsset(id, name, frozen)
				if e != nil {
					stop("invalid_candidate")
					return
				}
			}
			result, code := b.optimizationRun(ctx, scope, id, token, optimizationVariants[index], root, frozen, *model, asset)
			if code != "" {
				stop(code)
				return
			}
			if result.Violations > 0 {
				stop("permission_blocked")
				return
			}
			if result.Status != "completed" {
				reason := "failed"
				if strings.Contains(result.ErrorCode, "budget") {
					reason = "budget_exhausted"
				}
				stop(reason)
				return
			}
			if stage == 0 && result.Evaluation.Status == "passed" {
				answer := strategyDecode[Object](result.Answer)
				if answer["outcome"] == "blocked" {
					reason := "awaiting_reconciliation"
					switch answer["finding"] {
					case "authentication_blocked", "permission_blocked":
						reason = "permission_blocked"
					case "capability_missing":
						reason = "capability_missing"
					case "ambiguous_scope":
						reason = "target_ambiguous"
					case "no_progress":
						reason = "no_progress"
					}
					stop(reason)
					return
				}
			}
			if stage == 2 || stage == 4 {
				previous := "baseline_development"
				if stage == 4 {
					previous = "proposal_development"
				}
				before, _, _ := b.optimizationResult(id, previous)
				progress := strategy.SnapshotProgress(before.Evaluation, result.Evaluation, before.Violations, result.Violations)
				noProgress := integer(o["noProgress"])
				if integer(o["progressStage"]) < stage {
					noProgress++
					if progress {
						noProgress = 0
					}
				}
				_, e = strategyCall(b.Store, true, func() bool {
					b.Store.strategyCheckLease(scope, b.Store.strategyJob(scope, id), token)
					b.Store.exec("UPDATE strategyOptimizations SET noProgress=?,progressStage=? WHERE jobId=? AND progressStage<?", noProgress, stage, id, stage)
					return true
				})
				if e != nil {
					stop("source_changed")
					return
				}
				if noProgress >= frozen.Budget.MaxNoProgressRevisions {
					stop("no_progress")
					return
				}
				if stage == 4 && result.Evaluation.Status != "passed" {
					stop("verification_failed")
					return
				}
			}
		}
		if _, err = b.Store.checkpointOptimization(scope, id, token, stage+1); err != nil {
			stop("source_changed")
			return
		}
	}
}
func (b *Server) optimizationCandidate(id, stage string) (*strategyOptimizationCandidate, error) {
	row, err := strategyCall(b.Store, false, func() Object {
		return b.Store.row("SELECT status,resultJSON FROM strategyOptimizationCalls WHERE experimentId=? AND stage=?", id, stage)
	})
	if err != nil || row == nil || row["status"] != "completed" || row["resultJSON"] == "" {
		return nil, errors.New("candidate unavailable")
	}
	return strategyDecode[strategyOptimizationOutput](stringOf(row["resultJSON"])).Candidate, nil
}
func (b *Server) optimizationAsset(id, stage string, f strategyExperimentFrozen) (*strategy.AssetRevision, error) {
	c, err := b.optimizationCandidate(id, stage)
	if err != nil || c == nil {
		return nil, errors.New("candidate unavailable")
	}
	v := f.Asset
	v.Ref = strategy.RevisionRef{AssetID: "trial_" + id + "_" + stage, Revision: 1, ContentHash: strategy.ContentHash(c.Body)}
	v.ParentRevision = 0
	v.Body = c.Body
	v.Verification = strategy.SingleObservation
	return &v, nil
}
func (b *Server) optimizationResult(id, variant string) (ai.StrategyVariantResult, Object, error) {
	row, err := strategyCall(b.Store, false, func() Object {
		return b.Store.row("SELECT * FROM strategyExperimentRuns WHERE experimentId=? AND variant=?", id, variant)
	})
	if err != nil || row == nil {
		return ai.StrategyVariantResult{}, row, errors.New("run unavailable")
	}
	if row["reportJSON"] == "" {
		return ai.StrategyVariantResult{}, row, nil
	}
	return strategyDecode[ai.StrategyVariantResult](stringOf(row["reportJSON"])), row, nil
}
func (b *Server) optimizationRun(ctx context.Context, scope StrategyContext, id, token, variant, root string, f strategyExperimentFrozen, m ai.Model, asset *strategy.AssetRevision) (ai.StrategyVariantResult, string) {
	old, row, err := b.optimizationResult(id, variant)
	if err != nil {
		return old, "failed"
	}
	if row["status"] == "completed" && row["reportJSON"] != "" {
		return old, ""
	}
	if row["status"] != "planned" {
		return old, "awaiting_reconciliation"
	}
	fixture, ok := strategy.FindFixture(stringOf(row["caseId"]))
	versionOK := false
	for _, ff := range f.Cases {
		versionOK = versionOK || ff.ID == fixture.ID && ff.Version == fixture.Version
	}
	if !ok || !versionOK {
		return old, "fixture_changed"
	}
	runID := stringOf(row["id"])
	_, err = strategyCall(b.Store, true, func() bool {
		b.Store.strategyCheckLease(scope, b.Store.strategyJob(scope, id), token)
		b.Store.exec("UPDATE strategyExperimentRuns SET status='running',startedAt=? WHERE id=? AND status='planned'", now(), runID)
		return true
	})
	if err != nil {
		return old, "source_changed"
	}
	runCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	result := b.Engine.RunStrategyVariant(runCtx, ai.StrategyVariantInput{RunID: runID, Home: filepath.Join(root, runID), Fixture: fixture, Model: m, Asset: asset, SharedContext: f.SharedContext, Guard: func() error { return b.experimentGuard(scope, id, token, f) }, Safe: b.strategySafeText, Reserve: func(n int64) error {
		if e := b.experimentGuard(scope, id, token, f); e != nil {
			return e
		}
		_, e := b.Store.experimentBudget(scope, id, token, n, nil)
		return e
	}, Settle: func(n int64, u ai.Usage) error { _, e := b.Store.experimentBudget(scope, id, token, n, &u); return e }})
	if asset != nil && !optimizationApplied(result, asset.Ref) {
		result.Evaluation.Checks["candidate_applied"] = false
		result.Evaluation.Status = "failed"
	}
	guardErr := b.experimentGuard(scope, id, token, f)
	_, err = strategyCall(b.Store, true, func() bool {
		job := b.Store.row("SELECT * FROM strategyJobs WHERE id=?", id)
		raw := ""
		if guardErr == nil && strategyValidationCode(func() { b.Store.strategyCheckLease(scope, job, token) }) == "" && b.Store.row("SELECT frozenJSON FROM strategyExperiments WHERE jobId=?", id)["frozenJSON"] != "" && b.strategySafeText(jsonText(result)) {
			raw = jsonText(result)
		}
		b.Store.exec("UPDATE strategyExperimentRuns SET status=?,runtimeId=?,reportJSON=?,finishedAt=? WHERE id=? AND status='running'", result.Status, result.RuntimeID, raw, now(), runID)
		return true
	})
	if err != nil {
		return result, "result_unavailable"
	}
	if guardErr != nil {
		return result, "source_changed"
	}
	return result, ""
}
func (b *Server) optimizationModel(ctx context.Context, scope StrategyContext, id, token, stage string, f strategyExperimentFrozen, m ai.Model) (*strategyOptimizationCandidate, string) {
	row, err := strategyCall(b.Store, false, func() Object {
		return b.Store.row("SELECT * FROM strategyOptimizationCalls WHERE experimentId=? AND stage=?", id, stage)
	})
	if err != nil || row == nil {
		return nil, "failed"
	}
	if row["status"] == "completed" {
		return strategyDecode[strategyOptimizationOutput](stringOf(row["resultJSON"])).Candidate, ""
	}
	if row["status"] != "planned" {
		return nil, "awaiting_reconciliation"
	}
	development, ok := strategy.FindFixture(f.Cases[0].ID)
	if !ok || development.Version != f.Cases[0].Version || development.Split != "development" {
		return nil, "fixture_changed"
	}
	data := Object{"stage": stage, "seed": f.Asset.Body, "developmentTask": development.Prompt}
	ids := []string{}
	observations := []Object{}
	variants := []string{"baseline_development"}
	if stage == "synthesize" {
		variants = append(variants, "proposal_development")
		first, e := b.optimizationCandidate(id, "propose")
		if e != nil || first == nil {
			return nil, "invalid_candidate"
		}
		data["firstCandidate"] = first.Body
	}
	for _, variant := range variants {
		result, run, e := b.optimizationResult(id, variant)
		if e != nil || run["status"] != "completed" || run["reportJSON"] == "" {
			return nil, "source_changed"
		}
		ids = append(ids, stringOf(run["id"]))
		observation := Object{"runId": run["id"], "answer": result.Answer, "observed": result.Observed, "violations": result.Violations}
		// Only actually observed DEVELOPMENT material is available to the optimizer.
		if result.Observed > 0 {
			observation["evidence"] = development.ActorMaterial()
		}
		observations = append(observations, observation)
	}
	data["developmentRuns"] = observations
	content := jsonText(data)
	if len(content) > 32768 || !b.strategySafeText(content) {
		return nil, "unsafe_context"
	}
	if b.experimentGuard(scope, id, token, f) != nil {
		return nil, "source_changed"
	}
	reserve := int64(len(content) + len(strategyOptimizationPrompt) + m.MaxOutput + 1024)
	if _, err = b.Store.experimentBudget(scope, id, token, reserve, nil); err != nil {
		return nil, "budget_exhausted"
	}
	_, err = strategyCall(b.Store, true, func() bool {
		b.Store.strategyCheckLease(scope, b.Store.strategyJob(scope, id), token)
		b.Store.exec("UPDATE strategyOptimizationCalls SET status='running',requestHash=?,reservedTokens=?,startedAt=? WHERE id=? AND status='planned'", strategy.ContentHash(jsonText(Object{"prompt": strategyOptimizationPrompt, "data": data, "modelHash": experimentModelHash(m)})), reserve, now(), row["id"])
		return true
	})
	if err != nil {
		return nil, "source_changed"
	}
	callCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	output, usage, callErr := b.Engine.ExtractStrategyProposal(callCtx, m, []ai.Message{{Role: "system", Content: strategyOptimizationPrompt}, {Role: "user", Content: content}})
	_, _ = b.Store.experimentBudget(scope, id, token, reserve, &usage)
	code := ""
	parsed := strategyOptimizationOutput{}
	if callErr != nil {
		code = "model_error"
	} else {
		parsed, err = parseStrategyOptimization(output, ids)
		if err != nil {
			code = "invalid_output"
		} else if !b.strategySafeText(jsonText(parsed)) {
			code = "sensitive_output"
		}
	}
	guardErr := b.experimentGuard(scope, id, token, f)
	_, err = strategyCall(b.Store, true, func() bool {
		job := b.Store.row("SELECT * FROM strategyJobs WHERE id=?", id)
		raw := ""
		valid := guardErr == nil && strategyValidationCode(func() { b.Store.strategyCheckLease(scope, job, token) }) == "" && b.Store.row("SELECT frozenJSON FROM strategyExperiments WHERE jobId=?", id)["frozenJSON"] != ""
		if valid && code == "" {
			raw = jsonText(parsed)
		}
		state := "completed"
		if !valid || code != "" {
			state = "failed"
		}
		b.Store.exec("UPDATE strategyOptimizationCalls SET status=?,resultJSON=?,usageJSON=?,errorCode=?,finishedAt=? WHERE id=? AND status='running'", state, raw, jsonText(usage), code, now(), row["id"])
		return true
	})
	if err != nil {
		return nil, "result_unavailable"
	}
	if guardErr != nil {
		return nil, "source_changed"
	}
	if code != "" {
		return nil, code
	}
	return parsed.Candidate, ""
}
