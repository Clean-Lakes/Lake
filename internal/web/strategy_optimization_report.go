package web

import (
	"net/http"
	"strings"

	"github.com/Clean-Lakes/Lake/internal/ai"
	"github.com/Clean-Lakes/Lake/internal/strategy"
)

func optimizationApplied(result ai.StrategyVariantResult, ref strategy.RevisionRef) bool {
	if len(result.Manifests) == 0 {
		return false
	}
	for _, m := range result.Manifests {
		found := false
		for _, selected := range m.SelectedAssets {
			found = found || selected == ref
		}
		if !found {
			return false
		}
	}
	return true
}
func (b *Server) optimizationAssessment(id string, f strategyExperimentFrozen) (Object, []Object) {
	runs := []Object{}
	byVariant := map[string]Object{}
	for _, row := range b.Store.rows("SELECT * FROM strategyExperimentRuns WHERE experimentId=? ORDER BY ordinal", id) {
		fixture, _ := strategy.FindFixture(stringOf(row["caseId"]))
		run := Object{"id": row["id"], "caseId": row["caseId"], "split": fixture.Split, "arm": row["arm"], "variant": row["variant"], "status": row["status"], "repetition": 1}
		if row["reportJSON"] != "" && b.strategySafeText(stringOf(row["reportJSON"])) {
			result := strategyDecode[ai.StrategyVariantResult](stringOf(row["reportJSON"]))
			run["result"] = result
			run["passed"] = result.Evaluation.Status == "passed"
			run["repeatedObservations"] = max(0, result.Observed-1)
			if row["arm"] == "assets" {
				stage := "synthesize"
				if row["variant"] == "proposal_development" {
					stage = "propose"
				}
				call := b.Store.row("SELECT resultJSON FROM strategyOptimizationCalls WHERE experimentId=? AND stage=? AND status='completed'", id, stage)
				if call != nil && call["resultJSON"] != "" {
					c := strategyDecode[strategyOptimizationOutput](stringOf(call["resultJSON"])).Candidate
					if c != nil {
						ref := strategy.RevisionRef{AssetID: "trial_" + id + "_" + stage, Revision: 1, ContentHash: strategy.ContentHash(c.Body)}
						run["candidateApplied"] = optimizationApplied(result, ref)
					}
				}
				if run["candidateApplied"] != true {
					run["passed"] = false
				}
			}
		}
		runs = append(runs, run)
		byVariant[stringOf(row["variant"])] = run
	}
	splits := Object{}
	for _, split := range []string{"development", "holdout"} {
		summary := Object{"candidateWins": 0, "regressions": 0, "ties": 0, "missing": 0}
		a, bb := byVariant["baseline_"+split], byVariant["synthesis_"+split]
		bucket := "ties"
		if a == nil || bb == nil || a["status"] != "completed" || bb["status"] != "completed" || a["result"] == nil || bb["result"] == nil || bb["candidateApplied"] != true {
			bucket = "missing"
		} else if a["passed"] == true && bb["passed"] != true {
			bucket = "regressions"
		} else if a["passed"] != true && bb["passed"] == true {
			bucket = "candidateWins"
		}
		summary[bucket] = 1
		splits[split] = summary
	}
	return splits, runs
}
func (b *Server) finalizeOptimization(ctx StrategyContext, id, token string, f strategyExperimentFrozen) {
	reason := "completed"
	_, err := strategyCall(b.Store, true, func() bool {
		job := b.Store.strategyJob(ctx, id)
		b.Store.strategyCheckLease(ctx, job, token)
		splits, runs := b.optimizationAssessment(id, f)
		for _, split := range []string{"development", "holdout"} {
			s := object(splits[split])
			if integer(s["missing"]) > 0 {
				reason = "verification_failed"
			}
			if integer(s["regressions"]) > 0 {
				reason = "regression"
			}
		}
		finalPassed := map[string]bool{}
		for _, r := range runs {
			finalPassed[stringOf(r["variant"])] = r["passed"] == true
		}
		if !finalPassed["synthesis_development"] || !finalPassed["synthesis_holdout"] {
			if reason == "completed" {
				reason = "verification_failed"
			}
		}
		if reason == "completed" && integer(object(splits["development"])["candidateWins"]) == 0 {
			reason = "no_progress"
		}
		if b.Store.row("SELECT id FROM strategySourceEvents WHERE scopeKey=? AND originKey=?", job["scopeKey"], "experiment:"+id) != nil {
			return true
		}
		// Experience contains development metadata only, never holdout prompts,
		// observations, answers or hidden judge data.
		b.Store.exec("UPDATE strategyOptimizations SET summaryJSON=? WHERE jobId=?", jsonText(Object{"scope": "synthetic_development_only", "development": splits["development"], "limitations": "One development snapshot; no general effectiveness claim or automatic adoption."}), id)
		source := ident()
		key := stringOf(job["scopeKey"])
		digest := strategy.ContentHash(jsonText(Object{"runs": b.Store.rows("SELECT id,reportJSON,status FROM strategyExperimentRuns WHERE experimentId=? ORDER BY ordinal", id), "calls": b.Store.rows("SELECT id,requestHash,resultJSON,status FROM strategyOptimizationCalls WHERE experimentId=? ORDER BY stage", id)}))
		b.Store.exec("INSERT INTO strategySourceEvents VALUES(?,?,?,'fixture_evaluation','','',?,'Bounded synthetic optimization; inspect failures and holdout separately','available',?)", source, key, "experiment:"+id, digest, now())
		b.Store.strategyNode("source:"+source, key, "evidence", f.Asset.Ref.AssetID, f.Asset.Ref.Revision, source)
		b.Store.strategyNode("evaluation:"+id, key, "evaluation", f.Asset.Ref.AssetID, f.Asset.Ref.Revision, source)
		b.Store.strategyEdge(f.Asset.Ref.AssetID, revisionNode(f.Asset.Ref.AssetID, f.Asset.Ref.Revision), "evaluation:"+id, "tested_by")
		for _, call := range b.Store.rows("SELECT id,stage FROM strategyOptimizationCalls WHERE experimentId=? AND status='completed'", id) {
			b.Store.strategyNode("attempt:"+stringOf(call["id"]), key, "attempt", f.Asset.Ref.AssetID, f.Asset.Ref.Revision, source)
		}
		for _, r := range runs {
			b.Store.strategyNode("run:"+stringOf(r["id"]), key, "run", f.Asset.Ref.AssetID, f.Asset.Ref.Revision, source)
		}
		first := b.Store.row("SELECT id FROM strategyOptimizationCalls WHERE experimentId=? AND stage='propose'", id)
		syn := b.Store.row("SELECT id FROM strategyOptimizationCalls WHERE experimentId=? AND stage='synthesize'", id)
		b.Store.strategyEdge(f.Asset.Ref.AssetID, "attempt:"+stringOf(first["id"]), "run:"+stringOf(runs[0]["id"]), "proposed_to_fix")
		b.Store.strategyEdge(f.Asset.Ref.AssetID, "attempt:"+stringOf(syn["id"]), "attempt:"+stringOf(first["id"]), "composed_from")
		b.Store.strategyEdge(f.Asset.Ref.AssetID, "attempt:"+stringOf(syn["id"]), revisionNode(f.Asset.Ref.AssetID, f.Asset.Ref.Revision), "composed_from")
		for _, indices := range [][2]int{{0, 2}, {3, 4}} {
			b.Store.strategyEdge(f.Asset.Ref.AssetID, "run:"+stringOf(runs[indices[0]]["id"]), "run:"+stringOf(runs[indices[1]]["id"]), "compared_with")
		}
		return true
	})
	if err != nil {
		reason = "result_unavailable"
	}
	_, _ = b.Store.finishOptimization(ctx, id, token, reason)
}
func (b *Server) strategyOptimizationReport(ctx StrategyContext, id string) (Object, error) {
	return strategyCall(b.Store, false, func() Object {
		job := b.Store.strategyJob(ctx, id)
		o := b.Store.row("SELECT * FROM strategyOptimizations WHERE jobId=?", id)
		e := b.Store.row("SELECT * FROM strategyExperiments WHERE jobId=?", id)
		if o == nil || e == nil {
			strategyFail(404, "experiment_unavailable")
		}
		available := e["frozenJSON"] != "" && strategyValidationCode(func() { b.Store.strategySourceSet(ctx, b.Store.strategyJobSources(id)) }) == ""
		source := b.Store.row("SELECT id FROM strategySourceEvents WHERE originKey=? AND scopeKey=?", "experiment:"+id, job["scopeKey"])
		if source != nil && strategyValidationCode(func() { b.Store.strategySource(ctx, stringOf(source["id"]), true) }) != "" {
			available = false
		}
		out := Object{"id": id, "status": job["status"], "errorCode": job["errorCode"], "mode": "bounded_snapshot_optimization", "frozenHash": e["frozenHash"], "requests": e["requests"], "tokensCharged": e["tokensCharged"], "price": "unknown", "contentAvailable": available, "verdict": "inconclusive", "stage": o["stage"], "stopReason": o["stopReason"], "noProgress": o["noProgress"], "activeMs": o["activeMs"], "waitUntilMs": o["waitUntilMs"], "savedRevision": o["savedRevision"], "canSave": false, "canResume": available && o["stopReason"] == "awaiting_user" && job["status"] == "awaiting_reconciliation", "limitations": []string{"仅合成快照；不执行真实服务恢复，也未接入普通任务自动纠错。", "一轮提案和一轮合成，最多 5 个独立运行；所有请求/重试共用总预算。", "开发与保留集各一个场景，展示原始结果；没有统计显著性或通用收益结论。"}}
		f := strategyExperimentFrozen{}
		if available {
			f = strategyDecode[strategyExperimentFrozen](stringOf(e["frozenJSON"]))
			out["assetRef"] = f.Asset.Ref
			out["contextHash"] = f.ContextHash
			out["modelRef"] = f.ModelRef
			out["modelHash"] = f.ModelHash
			out["skillHashes"] = f.SkillHashes
			out["budget"] = f.Budget
			out["expectedRevision"] = job["expectedRevision"]
		}
		splits, runs := b.optimizationAssessment(id, f)
		calls := []Object{}
		for _, c := range b.Store.rows("SELECT * FROM strategyOptimizationCalls WHERE experimentId=? ORDER BY startedAt,stage", id) {
			view := Object{"id": c["id"], "stage": c["stage"], "status": c["status"], "requestHash": c["requestHash"], "usage": strategyDecode[ai.Usage](stringOf(c["usageJSON"])), "errorCode": c["errorCode"], "reservedTokens": c["reservedTokens"]}
			if available && c["resultJSON"] != "" && b.strategySafeText(stringOf(c["resultJSON"])) {
				view["result"] = strategyDecode[strategyOptimizationOutput](stringOf(c["resultJSON"]))
			}
			calls = append(calls, view)
		}
		if !available {
			for _, r := range runs {
				delete(r, "result")
				delete(r, "passed")
				delete(r, "candidateApplied")
			}
			splits = Object{"development": Object{"candidateWins": 0, "regressions": 0, "ties": 0, "missing": 1}, "holdout": Object{"candidateWins": 0, "regressions": 0, "ties": 0, "missing": 1}}
		}
		if available && job["status"] == "succeeded" && o["stopReason"] == "completed" {
			out["verdict"] = "candidate_better_on_selected_snapshots"
			out["canSave"] = integer(o["savedRevision"]) == 0
		}
		if o["stopReason"] == "regression" {
			out["verdict"] = "regression"
		}
		if available && o["summaryJSON"] != "" {
			out["experience"] = strategyDecode[Object](stringOf(o["summaryJSON"]))
		}
		out["calls"] = calls
		out["runs"] = runs
		out["splits"] = splits
		return out
	})
}
func (b *Server) strategyOptimizationAction(w http.ResponseWriter, r *http.Request, ctx StrategyContext, id, key, action string) {
	f := strategyMust(strategyCall(b.Store, false, func() strategyExperimentFrozen {
		b.Store.strategyJob(ctx, id)
		if b.Store.row("SELECT jobId FROM strategyOptimizations WHERE jobId=?", id) == nil {
			strategyFail(405, "unsupported_operation")
		}
		row := b.Store.row("SELECT frozenJSON FROM strategyExperiments WHERE jobId=?", id)
		if row["frozenJSON"] == "" {
			strategyFail(409, "source_unavailable")
		}
		return strategyDecode[strategyExperimentFrozen](stringOf(row["frozenJSON"]))
	}))
	if b.Models.ResolveModelIdentity(f.ModelRef) == nil || b.experimentSkillGuard(ctx, f.Asset, f.SkillHashes) != nil || integer(b.Store.MemorySettings(ctx.ProjectID)["epoch"]) != f.MemoryEpoch {
		strategyFail(409, "source_changed")
	}
	if action == "resume" {
		strategyBody[struct{}](r)
		reply(w, 200, strategyMust(b.Store.resumeOptimization(ctx, id, key)))
		return
	}
	in := strategyBody[struct {
		ExpectedRevision int64 `json:"expectedRevision"`
	}](r, "expectedRevision")
	reply(w, 200, strategyMust(b.saveOptimizationCandidate(ctx, id, key, in.ExpectedRevision)))
}
func (b *Server) saveOptimizationCandidate(ctx StrategyContext, id, key string, expected int64) (StrategyMutationResult, error) {
	return strategyCall(b.Store, true, func() StrategyMutationResult {
		job := b.Store.strategyJob(ctx, id)
		result, replayed, digest := b.Store.strategyReceipt(stringOf(job["scopeKey"]), key, Object{"operation": "save_optimization_candidate", "id": id, "expected": expected})
		if replayed {
			return result
		}
		o := b.Store.row("SELECT * FROM strategyOptimizations WHERE jobId=?", id)
		e := b.Store.row("SELECT * FROM strategyExperiments WHERE jobId=?", id)
		if o == nil || e == nil || e["frozenJSON"] == "" || job["status"] != "succeeded" || o["stopReason"] != "completed" || integer(o["savedRevision"]) != 0 {
			strategyFail(409, "candidate_unavailable")
		}
		// Recheck current generations and sources without treating elapsed model
		// deadline as permission to perform a new execution.
		job["expiresAtMs"] = int64(^uint64(0) >> 1)
		b.Store.strategyCheckJob(ctx, job)
		f := strategyDecode[strategyExperimentFrozen](stringOf(e["frozenJSON"]))
		call := b.Store.row("SELECT id,resultJSON FROM strategyOptimizationCalls WHERE experimentId=? AND stage='synthesize' AND status='completed'", id)
		if call == nil || call["resultJSON"] == "" {
			strategyFail(409, "candidate_unavailable")
		}
		c := strategyDecode[strategyOptimizationOutput](stringOf(call["resultJSON"])).Candidate
		if c == nil {
			strategyFail(409, "candidate_unavailable")
		}
		a := b.Store.strategyAsset(ctx, f.Asset.Ref.AssetID, false)
		if expected != int64(integer(a["revision"])) || expected != int64(integer(job["expectedRevision"])) {
			strategyFail(409, "revision_conflict")
		}
		source := b.Store.row("SELECT id FROM strategySourceEvents WHERE scopeKey=? AND originKey=?", job["scopeKey"], "experiment:"+id)
		if source == nil {
			strategyFail(409, "evaluation_unavailable")
		}
		b.Store.strategySource(ctx, stringOf(source["id"]), true)
		splits, runs := b.optimizationAssessment(id, f)
		if len(runs) != 5 || integer(object(splits["development"])["candidateWins"]) != 1 || integer(object(splits["holdout"])["regressions"]) != 0 || integer(object(splits["holdout"])["missing"]) != 0 {
			strategyFail(409, "verification_failed")
		}
		for _, r := range runs {
			if strings.HasPrefix(stringOf(r["variant"]), "synthesis_") && r["passed"] != true {
				strategyFail(409, "verification_failed")
			}
		}
		input := StrategyAssetInput{Title: stringOf(a["title"]), Kind: f.Asset.Kind, Body: c.Body, Applicability: f.Asset.Applicability}
		validateStrategyInput(input)
		b.strategySafeInput(input)
		sources := append(append([]string{}, f.Asset.SourceIDs...), stringOf(source["id"]))
		b.Store.strategyWriteRevision(ctx, a, expected+1, f.Asset.Ref.Revision, input, sources, strategy.FixtureValidated, "optimizer:"+id)
		b.Store.strategyEdge(f.Asset.Ref.AssetID, revisionNode(f.Asset.Ref.AssetID, expected+1), "evaluation:"+id, "tested_by")
		b.Store.strategyEdge(f.Asset.Ref.AssetID, revisionNode(f.Asset.Ref.AssetID, expected+1), "attempt:"+stringOf(call["id"]), "composed_from")
		b.Store.exec("UPDATE strategyOptimizations SET savedRevision=? WHERE jobId=?", expected+1, id)
		b.Store.strategyAdvanceScope(stringOf(a["scopeKey"]))
		b.Store.strategyInvalidateJobs("assetId=?", a["id"])
		result = StrategyMutationResult{AssetID: f.Asset.Ref.AssetID, Revision: expected + 1, JobID: id}
		b.Store.strategySaveReceipt(stringOf(job["scopeKey"]), key, digest, result)
		return result
	})
}
