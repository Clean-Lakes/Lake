package web

import (
	"context"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
	"github.com/Clean-Lakes/Lake/internal/strategy"
)

func experimentModelHash(m ai.Model) string {
	return strategy.ContentHash(jsonText(Object{"identity": ai.ModelIdentity(m), "contextWindow": m.ContextWindow, "maxOutput": m.MaxOutput, "reasoningEffort": m.ReasoningEffort}))
}
func (b *Server) experimentSkillGuard(ctx StrategyContext, asset strategy.AssetRevision, skillHashes map[string]string) error {
	sources, err := strategyCall(b.Store, false, func() []Object {
		out := []Object{}
		for _, id := range asset.SourceIDs {
			source := b.Store.strategySource(ctx, id, true)
			if source["kind"] == "skill_import" {
				out = append(out, source)
			}
		}
		return out
	})
	if err != nil {
		return err
	}
	hashes := map[string]string{}
	for name, digest := range skillHashes {
		hashes[name] = digest
	}
	for _, source := range sources {
		parts := strings.Split(stringOf(source["originKey"]), ":")
		if len(parts) != 4 {
			return errors.New("skill source unavailable")
		}
		hashes[parts[1]] = stringOf(source["contentHash"])
	}
	for name, digest := range hashes {
		meta, body, err := b.Extensions.Store.ReadSkill(name, "")
		if err != nil || !meta.Enabled || strategy.ContentHash(body) != digest {
			return errors.New("skill source changed")
		}
	}
	return nil
}
func (b *Server) experimentGuard(ctx StrategyContext, id, token string, frozen strategyExperimentFrozen) error {
	if _, err := b.Store.CheckStrategyJobLease(ctx, id, token); err != nil {
		return err
	}
	if integer(b.Store.MemorySettings(ctx.ProjectID)["epoch"]) != frozen.MemoryEpoch {
		return errors.New("memory source changed")
	}
	if b.Models.ResolveModelIdentity(frozen.ModelRef) == nil {
		return errors.New("model unavailable")
	}
	return b.experimentSkillGuard(ctx, frozen.Asset, frozen.SkillHashes)
}
func (b *Server) runExperimentWorker() {
	defer b.workers.Done()
	tick := time.NewTicker(5 * time.Second)
	defer tick.Stop()
	for {
		if b.Context.Err() != nil {
			return
		}
		b.processOneExperiment()
		b.pruneErasedExperiments()
		select {
		case <-b.Context.Done():
			return
		case <-tick.C:
		}
	}
}
func (b *Server) processOneExperiment() {
	var active StrategyContext
	id := ""
	defer func() {
		if recover() != nil && id != "" {
			job, _ := strategyCall(b.Store, false, func() Object { return b.Store.row("SELECT leaseToken FROM strategyJobs WHERE id=?", id) })
			_, _ = b.Store.finishOptimization(active, id, stringOf(job["leaseToken"]), "failed")
			_, _ = b.Store.failStrategyProposal(active, id, "experiment_internal_error")
			_, _ = b.Store.ObserveStrategyDispatch(active, id, "strategy_"+id, "complete")
		}
	}()
	b.messageMu.Lock()
	busy := len(b.runningMessages) > 0
	b.messageMu.Unlock()
	if busy || b.Context.Err() != nil {
		return
	}
	projects, err := strategyCall(b.Store, false, func() []Object {
		return b.Store.rows("SELECT DISTINCT j.accessProjectId FROM strategyJobs j JOIN strategyExperiments e ON e.jobId=j.id WHERE j.status='queued' ORDER BY j.createdAt LIMIT 32")
	})
	if err != nil {
		return
	}
	for _, p := range projects {
		scope := StrategyContext{ProjectID: stringOf(p["accessProjectId"])}
		job, e := b.Store.claimStrategyJob(scope, "experiment")
		if e != nil || job == nil {
			continue
		}
		active, id = scope, stringOf(job["id"])
		optimization, _ := strategyCall(b.Store, false, func() bool { return b.Store.row("SELECT jobId FROM strategyOptimizations WHERE jobId=?", id) != nil })
		if optimization {
			b.executeOptimization(scope, job)
			return
		}
		b.executeExperiment(scope, job)
		return
	}
}
func (b *Server) executeExperiment(scope StrategyContext, job Object) {
	id, token := stringOf(job["id"]), stringOf(job["leaseToken"])
	fail := func(code string) {
		_, _ = b.Store.failStrategyProposal(scope, id, code)
		_, _ = strategyCall(b.Store, true, func() bool {
			b.Store.exec("UPDATE strategyExperimentRuns SET status=CASE WHEN status='running' THEN 'unknown' ELSE 'not_executed' END,finishedAt=? WHERE experimentId=? AND status IN ('running','planned')", now(), id)
			return true
		})
	}
	row, err := strategyCall(b.Store, false, func() Object {
		b.Store.strategyCheckLease(scope, b.Store.strategyJob(scope, id), token)
		return b.Store.row("SELECT * FROM strategyExperiments WHERE jobId=?", id)
	})
	if err != nil || row == nil || row["frozenJSON"] == "" {
		fail("experiment_unavailable")
		return
	}
	frozen := strategyDecode[strategyExperimentFrozen](stringOf(row["frozenJSON"]))
	if strategy.ContentHash(stringOf(row["frozenJSON"])) != row["frozenHash"] || !b.strategySafeText(stringOf(row["frozenJSON"])) {
		fail("unsafe_input")
		return
	}
	model := b.Models.ResolveModelIdentity(frozen.ModelRef)
	if model == nil {
		fail("model_unavailable")
		return
	}
	model.ContextWindow = frozen.ContextWindow
	model.MaxOutput = frozen.MaxOutput
	model.ReasoningEffort = frozen.ReasoningEffort
	if model.Protocol != "openai" && model.Protocol != "" {
		fail("unsupported_model")
		return
	}
	runtime, err := b.Store.PrepareStrategyDispatch(scope, id, token)
	if err != nil {
		fail("dispatch_conflict")
		return
	}
	defer func() { _, _ = b.Store.ObserveStrategyDispatch(scope, id, runtime, "complete") }()
	_, _ = b.Store.ObserveStrategyDispatch(scope, id, runtime, "started")
	ctx, cancel := context.WithDeadline(b.Context, time.UnixMilli(int64(integer(job["expiresAtMs"]))))
	defer cancel()
	stopped := make(chan struct{})
	watchDone := make(chan struct{})
	go func() {
		defer close(watchDone)
		tick := time.NewTicker(250 * time.Millisecond)
		defer tick.Stop()
		for {
			select {
			case <-stopped:
				return
			case <-ctx.Done():
				return
			case <-tick.C:
				if e := b.experimentGuard(scope, id, token, frozen); e != nil {
					cancel()
					return
				}
			}
		}
	}()
	defer func() { close(stopped); <-watchDone }()
	root := filepath.Join(b.options.DataDir, "strategy-experiments")
	if os.MkdirAll(root, 0700) != nil {
		fail("reset_failed")
		return
	}
	runs, err := strategyCall(b.Store, false, func() []Object {
		return b.Store.rows("SELECT * FROM strategyExperimentRuns WHERE experimentId=? ORDER BY ordinal", id)
	})
	if err != nil {
		fail("storage_error")
		return
	}
	for _, run := range runs {
		if _, err = b.Store.CheckStrategyJobLease(scope, id, token); err != nil {
			break
		}
		f, ok := strategy.FindFixture(stringOf(run["caseId"]))
		if !ok {
			fail("fixture_changed")
			break
		}
		versionOK := false
		for _, ff := range frozen.Cases {
			versionOK = versionOK || ff.ID == f.ID && ff.Version == f.Version
		}
		if !versionOK {
			fail("fixture_changed")
			break
		}
		runID := stringOf(run["id"])
		_, err = strategyCall(b.Store, true, func() bool {
			b.Store.strategyCheckLease(scope, b.Store.strategyJob(scope, id), token)
			if b.Store.row("SELECT status FROM strategyExperimentRuns WHERE id=?", runID)["status"] != "planned" {
				strategyFail(409, "run_already_started")
			}
			b.Store.exec("UPDATE strategyExperimentRuns SET status='running',startedAt=? WHERE id=?", now(), runID)
			return true
		})
		if err != nil {
			break
		}
		var asset *strategy.AssetRevision
		if run["arm"] == "assets" {
			value := frozen.Asset
			asset = &value
		}
		runCtx, stop := context.WithTimeout(ctx, 60*time.Second)
		result := b.Engine.RunStrategyVariant(runCtx, ai.StrategyVariantInput{RunID: runID, Home: filepath.Join(root, runID), Fixture: f, Model: *model, Asset: asset, SharedContext: frozen.SharedContext,
			Guard: func() error { return b.experimentGuard(scope, id, token, frozen) }, Safe: b.strategySafeText,
			Reserve: func(n int64) error {
				if err := b.experimentGuard(scope, id, token, frozen); err != nil {
					return err
				}
				_, e := b.Store.experimentBudget(scope, id, token, n, nil)
				return e
			}, Settle: func(n int64, u ai.Usage) error { _, e := b.Store.experimentBudget(scope, id, token, n, &u); return e }})
		stop()
		guardErr := b.experimentGuard(scope, id, token, frozen)
		_, err = strategyCall(b.Store, true, func() bool {
			current := b.Store.row("SELECT * FROM strategyJobs WHERE id=? AND accessProjectId=?", id, scope.ProjectID)
			available := guardErr == nil && strategyValidationCode(func() { b.Store.strategyCheckLease(scope, current, token) }) == ""
			raw := ""
			if available && b.Store.row("SELECT frozenJSON FROM strategyExperiments WHERE jobId=?", id)["frozenJSON"] != "" && b.strategySafeText(jsonText(result)) {
				raw = jsonText(result)
			}
			b.Store.exec("UPDATE strategyExperimentRuns SET status=?,runtimeId=?,reportJSON=?,finishedAt=? WHERE id=? AND status='running'", result.Status, result.RuntimeID, raw, now(), runID)
			return true
		})
		if err != nil {
			fail("result_unavailable")
			break
		}
		if guardErr != nil {
			fail("source_changed")
			break
		}
	}
	_, err = strategyCall(b.Store, true, func() bool {
		current := b.Store.strategyJob(scope, id)
		code := strategyValidationCode(func() { b.Store.strategyCheckLease(scope, current, token) })
		b.Store.exec("UPDATE strategyExperimentRuns SET status='not_executed',finishedAt=? WHERE experimentId=? AND status='planned'", now(), id)
		if code != "" {
			if current["status"] != "cancelled" && current["status"] != "failed" {
				b.Store.exec("UPDATE strategyJobs SET status='failed',errorCode=?,leaseToken='',leaseUntilMs=0 WHERE id=?", code, id)
			}
			return false
		}
		b.Store.exec("UPDATE strategyJobs SET status='succeeded',leaseToken='',leaseUntilMs=0,updatedAt=? WHERE id=?", now(), id)
		// Evaluation is provenance, not an immutable asset verification upgrade.
		source := ident()
		key := stringOf(current["scopeKey"])
		digest := strategy.ContentHash(jsonText(b.Store.rows("SELECT id,status,reportJSON FROM strategyExperimentRuns WHERE experimentId=? ORDER BY ordinal", id)))
		b.Store.exec("INSERT INTO strategySourceEvents VALUES(?,?,?,'fixture_evaluation','','',?,'Synthetic snapshot evaluation; inspect all failures','available',?)", source, key, "experiment:"+id, digest, now())
		node := "evaluation:" + id
		b.Store.strategyNode(node, key, "evaluation", frozen.Asset.Ref.AssetID, frozen.Asset.Ref.Revision, source)
		b.Store.strategyEdge(frozen.Asset.Ref.AssetID, revisionNode(frozen.Asset.Ref.AssetID, frozen.Asset.Ref.Revision), node, "tested_by")
		b.Store.strategyEvent(key, scope.ProjectID, id, 1, "experiment_completed", Object{"evaluationHash": digest})
		return true
	})
	if err != nil {
		fail("result_unavailable")
	}
}
func (b *Server) pruneErasedExperiments() {
	runs, err := strategyCall(b.Store, false, func() []Object {
		return b.Store.rows("SELECT r.id FROM strategyExperimentRuns r JOIN strategyExperiments e ON e.jobId=r.experimentId WHERE e.frozenJSON='' AND r.status<>'running' LIMIT 1000")
	})
	if err != nil {
		return
	}
	for _, r := range runs {
		id := stringOf(r["id"])
		decoded, decodeErr := hex.DecodeString(id)
		if decodeErr == nil && len(decoded) == 16 {
			_ = os.RemoveAll(filepath.Join(b.options.DataDir, "strategy-experiments", id))
		}
	}
}
