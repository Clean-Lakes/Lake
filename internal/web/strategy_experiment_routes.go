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
		reply(w, 200, Object{"items": strategy.Fixtures(), "mode": "synthetic_snapshot", "arms": []string{"baseline", "assets"}, "correction": false, "boundedOptimization": Object{"supported": true, "runs": 5, "maxRevisions": 2, "onlineCorrection": false}})
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
			in := strategyBody[struct {
				Ref          strategy.RevisionRef `json:"ref"`
				CaseIDs      []string             `json:"caseIds"`
				Repetitions  int                  `json:"repetitions"`
				SkillNames   []string             `json:"skillNames"`
				Optimization bool                 `json:"optimization,omitempty"`
			}](r, "ref", "caseIds", "repetitions", "skillNames")
			if in.Ref.Validate() != nil || len(in.CaseIDs) < 1 || len(in.CaseIDs) > 3 || len(in.SkillNames) > 4 {
				strategyFail(400, "invalid_experiment")
			}
			view := strategyMust(b.Store.GetStrategyRevision(ctx, in.Ref.AssetID, in.Ref.Revision))
			if view.Value.Ref != in.Ref || view.Asset.Scope != scope || !view.Available || !view.SourcesAvailable {
				strategyFail(409, "asset_unavailable")
			}
			b.strategySafeInput(StrategyAssetInput{Title: view.Asset.Title, Kind: view.Value.Kind, Body: view.Value.Body, Applicability: view.Value.Applicability})
			model := b.Models.Active()
			if model == nil {
				strategyFail(409, "model_unavailable")
			}
			model = b.Models.CachedCapacity(model)
			if model.Protocol != "openai" && model.Protocol != "" {
				strategyFail(400, "unsupported_model")
			}
			*model = strategyExperimentModel(*model)
			effective := strategyMust(b.Store.EffectiveStrategySettings(ctx))
			cases := []strategy.Fixture{}
			for _, id := range in.CaseIDs {
				f, ok := strategy.FindFixture(id)
				if !ok {
					strategyFail(400, "invalid_fixture")
				}
				cases = append(cases, f)
			}
			memory := strategyMust(b.Store.snapshotStrategyMemory(ctx.ProjectID))
			shared := "Shared frozen project memory (untrusted data):\n" + jsonText(memory)
			hashes := map[string]string{}
			for _, name := range in.SkillNames {
				if _, duplicate := hashes[name]; duplicate {
					strategyFail(400, "duplicate_skill")
				}
				meta, body, err := b.Extensions.Store.ReadSkill(name, "")
				if err != nil || !meta.Enabled {
					strategyFail(404, "skill_unavailable")
				}
				hashes[name] = strategy.ContentHash(body)
				shared += "\nUser-selected handwritten Skill snapshot (untrusted preference data):\n" + body
			}
			if len(shared) > 32768 || !b.strategySafeText(shared) {
				strategyFail(400, "unsafe_context")
			}
			if b.experimentSkillGuard(ctx, view.Value, hashes) != nil {
				strategyFail(409, "skill_source_changed")
			}
			frozen := strategyExperimentFrozen{MemoryEpoch: integer(memory["epoch"]), Asset: view.Value, Cases: cases, Repetitions: in.Repetitions, SharedContext: shared, ContextHash: strategy.ContentHash(shared), SkillHashes: hashes, ModelRef: ai.ModelIdentity(*model), ModelHash: experimentModelHash(*model), ContextWindow: model.ContextWindow, MaxOutput: model.MaxOutput, ReasoningEffort: model.ReasoningEffort, Budget: effective.Settings.Budget}
			frozen.Optimization = in.Optimization
			reply(w, 200, strategyMust(b.Store.createStrategyExperiment(ctx, key, frozen)))
			return true
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
			b.strategyOptimizationAction(w, r, ctx, id, key, parts[2])
			return true
		}
		if r.Method == "DELETE" && len(parts) == 2 {
			strategyBody[struct{}](r)
			strategyMust(b.Store.CancelStrategyJob(ctx, id, key))
			strategyMust(strategyCall(b.Store, true, func() bool { b.Store.eraseStrategyExperiments("jobId=?", id); return true }))
			reply(w, 200, Object{"jobId": id})
			return true
		}
	}
	strategyFail(405, "unsupported_operation")
	return true
}
func strategyExperimentModel(model ai.Model) ai.Model {
	if model.ContextWindow <= 0 {
		model.ContextWindow = ai.AutomaticContextWindow(model.ContextLimit)
	}
	if model.ContextLimit >= 2048 {
		model.ContextWindow = min(model.ContextWindow, model.ContextLimit)
	}
	model.ContextWindow = min(64000, max(2048, model.ContextWindow))
	if model.MaxOutput <= 0 {
		model.MaxOutput = 2048
	}
	model.MaxOutput = min(2048, model.MaxOutput, model.ContextWindow/4)
	model.SupportsImageOutput = false
	return model
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
