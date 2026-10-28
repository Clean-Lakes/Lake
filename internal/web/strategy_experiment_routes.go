package web

import (
	"github.com/Clean-Lakes/Lake/internal/ai"
	"github.com/Clean-Lakes/Lake/internal/strategy"
	"net/http"
	"strconv"
	"strings"
)

func (b *Server) strategyExperimentRoute(w http.ResponseWriter, r *http.Request, ctx StrategyContext, scope strategy.Scope, suffix, key string) bool {
	if suffix != "/fixtures" && !strings.HasPrefix(suffix, "/experiments") {
		return false
	}
	if ctx.ProjectID == "" {
		strategyFail(404, "project_required")
	}
	if suffix == "/fixtures" && r.Method == "GET" {
		reply(w, 200, Object{"items": []strategy.Fixture{}, "mode": "retired", "arms": []string{}, "correction": false, "boundedOptimization": Object{"supported": false, "retired": true, "onlineCorrection": false}})
		return true
	}
	if suffix == "/experiments" {
		if r.Method == "GET" {
			items := strategyMust(strategyCall(b.Store, false, func() []Object {
				return b.Store.rows("SELECT j.id,j.status,j.errorCode,j.createdAt,e.frozenHash,e.requests,e.tokensCharged FROM strategyJobs j JOIN strategyExperiments e ON e.jobId=j.id WHERE j.accessProjectId=? ORDER BY j.createdAt DESC,j.id DESC LIMIT 50", ctx.ProjectID)
			}))
			reply(w, 200, Object{"items": items})
			return true
		}
		if r.Method == "POST" {
			strategyFail(410, "execution_retired")
		}
	}
	parts := strings.Split(strings.Trim(suffix, "/"), "/")
	if len(parts) >= 2 && parts[0] == "experiments" {
		id := parts[1]
		strategyMust(strategyCall(b.Store, false, func() bool {
			b.Store.strategyJob(ctx, id)
			if b.Store.row("SELECT jobId FROM strategyExperiments WHERE jobId=?", id) == nil {
				strategyFail(404, "experiment_unavailable")
			}
			return true
		}))
		if r.Method == "GET" && (len(parts) == 2 || len(parts) == 3 && parts[2] == "report") {
			reply(w, 200, strategyMust(b.strategyExperimentReport(ctx, id)))
			return true
		}
		if r.Method == "POST" && len(parts) == 3 && parts[2] == "cancel" {
			strategyBody[struct{}](r)
			reply(w, 200, strategyMust(b.Store.CancelStrategyJob(ctx, id, key)))
			return true
		}
		if r.Method == "POST" && len(parts) == 3 && (parts[2] == "resume" || parts[2] == "save-candidate") {
			strategyFail(410, "optimization_retired")
			return true
		}
		if r.Method == "DELETE" && len(parts) == 2 {
			strategyBody[struct{}](r)
			strategyMust(b.Store.CancelStrategyJob(ctx, id, key))
			strategyMust(strategyCall(b.Store, true, func() bool { b.Store.eraseStrategyExperiments("jobId=?", id); return true }))
			b.pruneErasedExperiments()
			reply(w, 200, Object{"jobId": id})
			return true
		}
	}
	strategyFail(405, "unsupported_operation")
	return true
}
func (b *Server) strategyExperimentReport(ctx StrategyContext, id string) (Object, error) {
	optimization, err := strategyCall(b.Store, false, func() bool {
		b.Store.strategyJob(ctx, id)
		return b.Store.row("SELECT jobId FROM strategyOptimizations WHERE jobId=?", id) != nil
	})
	if err != nil {
		return nil, err
	}
	if optimization {
		return b.strategyOptimizationReport(ctx, id)
	}
	return strategyCall(b.Store, false, func() Object {
		job := b.Store.strategyJob(ctx, id)
		experiment := b.Store.row("SELECT * FROM strategyExperiments WHERE jobId=?", id)
		if experiment == nil {
			strategyFail(404, "experiment_unavailable")
		}
		out := Object{"id": id, "status": job["status"], "errorCode": job["errorCode"], "mode": "synthetic_snapshot", "frozenHash": experiment["frozenHash"], "requests": experiment["requests"], "tokensCharged": experiment["tokensCharged"], "price": "unknown", "verdict": "inconclusive", "limitations": []string{"仅合成快照；未执行真实主机/容器/数据库恢复。", "固定结构、证据与关键词检查，不等于完整语义正确性。", "样本不足不作统计显著性或通用收益结论；不自动采用。"}}
		available := experiment["frozenJSON"] != "" && strategyValidationCode(func() { b.Store.strategySourceSet(ctx, b.Store.strategyJobSources(id)) }) == ""
		if available {
			frozen := strategyDecode[strategyExperimentFrozen](stringOf(experiment["frozenJSON"]))
			out["assetRef"] = frozen.Asset.Ref
			out["contextHash"] = frozen.ContextHash
			out["skillHashes"] = frozen.SkillHashes
			out["modelRef"] = frozen.ModelRef
			out["modelHash"] = frozen.ModelHash
			out["budget"] = frozen.Budget
		}
		runs := []Object{}
		pairs := map[string]map[string]Object{}
		splits := Object{"development": Object{"candidateWins": 0, "regressions": 0, "ties": 0, "missing": 0}, "holdout": Object{"candidateWins": 0, "regressions": 0, "ties": 0, "missing": 0}}
		for _, r := range b.Store.rows("SELECT * FROM strategyExperimentRuns WHERE experimentId=? ORDER BY ordinal", id) {
			f, _ := strategy.FindFixture(stringOf(r["caseId"]))
			run := Object{"id": r["id"], "ordinal": r["ordinal"], "caseId": r["caseId"], "split": f.Split, "arm": r["arm"], "repetition": r["repetition"], "status": r["status"], "startedAt": r["startedAt"], "finishedAt": r["finishedAt"]}
			if available && r["reportJSON"] != "" && b.strategySafeText(stringOf(r["reportJSON"])) {
				result := strategyDecode[ai.StrategyVariantResult](stringOf(r["reportJSON"]))
				run["result"] = result
				run["repeatedObservations"] = max(0, result.Observed-1)
				run["passed"] = result.Evaluation.Status == "passed"
				if r["arm"] == "assets" {
					applied := false
					for _, m := range result.Manifests {
						for _, ref := range m.SelectedAssets {
							applied = applied || ref == strategyDecode[strategyExperimentFrozen](stringOf(experiment["frozenJSON"])).Asset.Ref
						}
					}
					run["candidateApplied"] = applied
					if !applied {
						run["passed"] = false
					}
				}
			}
			pairKey := stringOf(r["caseId"]) + ":" + strconv.Itoa(integer(r["repetition"]))
			if pairs[pairKey] == nil {
				pairs[pairKey] = map[string]Object{}
			}
			pairs[pairKey][stringOf(r["arm"])] = run
			runs = append(runs, run)
		}
		regressions, wins, missing := 0, 0, 0
		for _, pair := range pairs {
			a, bb := pair["baseline"], pair["assets"]
			split := "development"
			if a != nil {
				split = stringOf(a["split"])
			} else if bb != nil {
				split = stringOf(bb["split"])
			}
			summary := object(splits[split])
			bucket := "ties"
			if a == nil || bb == nil || a["status"] != "completed" || bb["status"] != "completed" || a["result"] == nil || bb["result"] == nil || bb["candidateApplied"] != true {
				bucket = "missing"
				missing++
			} else if a["passed"] == true && bb["passed"] != true {
				bucket = "regressions"
				regressions++
			} else if a["passed"] != true && bb["passed"] == true {
				bucket = "candidateWins"
				wins++
			}
			summary[bucket] = integer(summary[bucket]) + 1
		}
		if available && job["status"] == "succeeded" && missing == 0 {
			verdict := "no_difference"
			if wins > 0 {
				verdict = "candidate_better_on_selected_snapshots"
			}
			if regressions > 0 {
				verdict = "regression"
			}
			out["verdict"] = verdict
		}
		out["runs"] = runs
		out["splits"] = splits
		out["contentAvailable"] = available
		return out
	})
}
