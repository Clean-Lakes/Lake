package web

import (
	"github.com/Clean-Lakes/Lake/internal/ai"
	"github.com/Clean-Lakes/Lake/internal/strategy"
	"time"
)

type strategyExperimentFrozen struct {
	Optimization    bool                   `json:"optimization,omitempty"`
	MemoryEpoch     int                    `json:"memoryEpoch"`
	Asset           strategy.AssetRevision `json:"asset"`
	Cases           []strategy.Fixture     `json:"cases"`
	Repetitions     int                    `json:"repetitions"`
	SharedContext   string                 `json:"sharedContext"`
	ContextHash     string                 `json:"contextHash"`
	SkillHashes     map[string]string      `json:"skillHashes"`
	ModelRef        string                 `json:"modelRef"`
	ModelHash       string                 `json:"modelHash"`
	ContextWindow   int                    `json:"contextWindow"`
	MaxOutput       int                    `json:"maxOutput"`
	ReasoningEffort string                 `json:"reasoningEffort"`
	Budget          strategy.Budget        `json:"budget"`
}

func (s *Store) createStrategyExperiment(ctx StrategyContext, key string, frozen strategyExperimentFrozen) (StrategyMutationResult, error) {
	return strategyCall(s, true, func() StrategyMutationResult {
		scope := strategy.Scope{Kind: strategy.ProjectScope, ProjectID: ctx.ProjectID}
		scopeKey := s.strategyEnsureScope(ctx, scope)
		result, replayed, digest := s.strategyReceipt(scopeKey, key, Object{"operation": "experiment", "frozen": frozen})
		if replayed {
			return result
		}
		ref := frozen.Asset.Ref
		view := s.strategyRevisionView(ctx, ref.AssetID, ref.Revision)
		if view.Asset.Scope != scope || !view.Available || !view.SourcesAvailable || view.Value.Ref != ref {
			strategyFail(409, "asset_unavailable")
		}
		if !frozen.Optimization && (len(frozen.Cases) < 1 || len(frozen.Cases) > 3 || frozen.Repetitions < 1 || frozen.Repetitions > 3 || len(frozen.Cases)*frozen.Repetitions*2 > frozen.Budget.MaxRuns) {
			strategyFail(400, "run_budget")
		}
		effective := s.strategyEffective(ctx)
		if frozen.Budget != effective.Settings.Budget {
			strategyFail(409, "settings_changed")
		}
		if frozen.Optimization {
			if !effective.Settings.CorrectEnabled {
				strategyFail(409, "correction_disabled")
			}
			if len(frozen.Cases) != 2 || frozen.Cases[0].Split != "development" || frozen.Cases[1].Split != "holdout" || frozen.Repetitions != 1 {
				strategyFail(400, "optimization_cases")
			}
			if frozen.Budget.MaxRuns < 5 || frozen.Budget.MaxRevisions < 2 {
				strategyFail(400, "optimization_budget")
			}
		}
		seen := map[string]bool{}
		for _, f := range frozen.Cases {
			registered, ok := strategy.FindFixture(f.ID)
			if !ok || seen[f.ID] || registered.Version != f.Version {
				strategyFail(400, "invalid_fixture")
			}
			seen[f.ID] = true
		}
		result = s.strategyQueueJob(ctx, "experiment:"+strategy.ContentHash(key+digest), StrategyJobInput{Scope: scope, Kind: "experiment", AssetID: ref.AssetID, ExpectedRevision: view.Asset.Revision, SourceIDs: view.Value.SourceIDs})
		raw := jsonText(frozen)
		s.exec("INSERT INTO strategyExperiments(jobId,frozenJSON,frozenHash,modelRef,createdAt) VALUES(?,?,?,?,?)", result.JobID, raw, strategy.ContentHash(raw), frozen.ModelRef, now())
		if frozen.Optimization {
			s.strategyPlanOptimization(result.JobID, frozen)
			s.strategySaveReceipt(scopeKey, key, digest, result)
			return result
		}
		ordinal := 0
		for ci, f := range frozen.Cases {
			for rep := 0; rep < frozen.Repetitions; rep++ {
				arms := []string{"baseline", "assets"}
				if (ci+rep)%2 == 1 {
					arms = []string{"assets", "baseline"}
				}
				for _, arm := range arms {
					ordinal++
					s.exec("INSERT INTO strategyExperimentRuns(id,experimentId,ordinal,caseId,arm,repetition,status) VALUES(?,?,?,?,?,?,'planned')", ident(), result.JobID, ordinal, f.ID, arm, rep+1)
				}
			}
		}
		s.strategyEvent(scopeKey, ctx.ProjectID, result.JobID, 1, "experiment_created", Object{"frozenHash": strategy.ContentHash(raw), "runs": ordinal})
		s.strategySaveReceipt(scopeKey, key, digest, result)
		return result
	})
}
func (s *Store) experimentBudget(ctx StrategyContext, id, token string, reserve int64, usage *ai.Usage) (bool, error) {
	return strategyCall(s, true, func() bool {
		job := s.row("SELECT * FROM strategyJobs WHERE id=? AND accessProjectId=?", id, ctx.ProjectID)
		if job == nil {
			strategyFail(404, "job_unavailable")
		}
		row := s.row("SELECT * FROM strategyExperiments WHERE jobId=?", id)
		if row == nil {
			strategyFail(404, "experiment_unavailable")
		}
		if usage != nil {
			charge := reserve
			if usage.InputKnown && usage.OutputKnown {
				charge = int64(usage.Input + usage.Output)
				if charge < 0 {
					charge = reserve
				}
			}
			// A trusted settlement may record usage after cancellation. It never
			// reopens dispatch authorization or refunds an unknown reservation.
			s.exec("UPDATE strategyExperiments SET tokensCharged=tokensCharged-?+? WHERE jobId=?", reserve, charge, id)
			return true
		}
		s.strategyCheckLease(ctx, job, token)
		if row["frozenJSON"] == "" {
			strategyFail(409, "source_unavailable")
		}
		frozen := strategyDecode[strategyExperimentFrozen](stringOf(row["frozenJSON"]))
		if reserve < 1 || integer(row["requests"]) >= frozen.Budget.MaxOptimizationRequests || int64(integer(row["tokensCharged"]))+reserve > frozen.Budget.MaxAdditionalTokens {
			strategyFail(409, "experiment_budget")
		}
		s.exec("UPDATE strategyExperiments SET requests=requests+1,tokensCharged=tokensCharged+? WHERE jobId=?", reserve, id)
		until := min(time.Now().Add(strategyLeaseDuration).UnixMilli(), int64(integer(job["expiresAtMs"])))
		s.exec("UPDATE strategyJobs SET leaseUntilMs=? WHERE id=?", until, id)
		return true
	})
}
func (s *Store) recoverStrategyExperiments() {
	s.recoverStrategyOptimizations()
	// Snapshot tools have no resource-side effects. Unknown MODEL results remain
	// unknown; no arm or model request is started again after a process crash.
	s.exec("UPDATE strategyExperimentRuns SET status='unknown',finishedAt=? WHERE status='running' AND experimentId NOT IN (SELECT jobId FROM strategyOptimizations)", now())
	s.exec("UPDATE strategyExperimentRuns SET status='not_executed',finishedAt=? WHERE status='planned' AND experimentId IN (SELECT id FROM strategyJobs WHERE dispatchState<>'none') AND experimentId NOT IN (SELECT jobId FROM strategyOptimizations)", now())
	s.exec("UPDATE strategyJobs SET status=CASE WHEN status IN ('cancelled','succeeded') THEN status ELSE 'failed' END,errorCode=CASE WHEN status='succeeded' THEN errorCode ELSE 'experiment_interrupted' END,dispatchState='complete',leaseToken='',leaseUntilMs=0,updatedAt=? WHERE id IN (SELECT jobId FROM strategyExperiments) AND id NOT IN (SELECT jobId FROM strategyOptimizations) AND dispatchState<>'none' AND status IN ('leased','awaiting_reconciliation','cancelled','failed','succeeded')", now())
}
func (s *Store) eraseStrategyExperiments(where string, args ...any) {
	s.exec("UPDATE strategyOptimizationCalls SET resultJSON='' WHERE experimentId IN (SELECT jobId FROM strategyExperiments WHERE "+where+")", args...)
	s.exec("UPDATE strategyOptimizations SET summaryJSON='' WHERE jobId IN (SELECT jobId FROM strategyExperiments WHERE "+where+")", args...)
	s.exec("UPDATE strategySourceEvents SET availability='tombstoned',summary='' WHERE availability='available' AND originKey IN (SELECT 'experiment:'||jobId FROM strategyExperiments WHERE "+where+")", args...)
	s.exec("UPDATE strategyExperimentRuns SET reportJSON='' WHERE experimentId IN (SELECT jobId FROM strategyExperiments WHERE "+where+")", args...)
	s.exec("UPDATE strategyExperiments SET frozenJSON='' WHERE "+where, args...)
}

func (s *Store) snapshotStrategyMemory(project string) (Object, error) {
	return strategyCall(s, false, func() Object {
		settings := s.memorySettings(project)
		items := []Object{}
		used, omitted := 0, 0
		if settings["useEnabled"] == true {
			for _, row := range s.rows("SELECT key,type,description,body,revision,validUntil FROM projectMemories WHERE projectId=? AND deletedAt='' ORDER BY key", project) {
				if memoryExpired(row, time.Now()) {
					continue
				}
				size := len(jsonText(row))
				if used+size > 16384 {
					omitted++
					continue
				}
				used += size
				items = append(items, row)
			}
		}
		return Object{"items": items, "omitted": omitted, "epoch": settings["epoch"], "revision": settings["revision"], "enabled": settings["useEnabled"]}
	})
}
