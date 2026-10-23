package web

import (
	"github.com/Clean-Lakes/Lake/internal/ai"
	"github.com/Clean-Lakes/Lake/internal/strategy"
)

// Only historical payload types remain; no optimizer prompt or actor is compiled.
type strategyOptimizationCandidate struct {
	Body                string   `json:"body"`
	Reason              string   `json:"reason"`
	RefutedHypothesis   string   `json:"refutedHypothesis"`
	Changes             string   `json:"changes"`
	ExpectedInformation string   `json:"expectedInformation"`
	StopCondition       string   `json:"stopCondition"`
	SourceRunIDs        []string `json:"sourceRunIds"`
}
type strategyOptimizationOutput struct {
	SchemaVersion int                            `json:"schemaVersion"`
	Candidate     *strategyOptimizationCandidate `json:"candidate"`
}

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
		out := Object{"id": id, "status": job["status"], "errorCode": job["errorCode"], "mode": "bounded_snapshot_optimization", "frozenHash": e["frozenHash"], "requests": e["requests"], "tokensCharged": e["tokensCharged"], "price": "unknown", "contentAvailable": available, "verdict": "inconclusive", "stage": o["stage"], "stopReason": o["stopReason"], "noProgress": o["noProgress"], "activeMs": o["activeMs"], "waitUntilMs": o["waitUntilMs"], "savedRevision": o["savedRevision"], "canSave": false, "canResume": false, "retired": true, "limitations": []string{"仅合成快照；不执行真实服务恢复，也未接入普通任务自动纠错。", "一轮提案和一轮合成，最多 5 个独立运行；所有请求/重试共用总预算。", "开发与保留集各一个场景，展示原始结果；没有统计显著性或通用收益结论。"}}
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
