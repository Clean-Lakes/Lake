package web

import "github.com/Clean-Lakes/Lake/internal/strategy"

type StrategySettingsInput struct {
	MasterEnabled, ApplyEnabled, LearnEnabled, CorrectEnabled bool
	OnlineCorrectEnabled                                      bool
	Budget                                                    strategy.Budget
}
type StrategyEffectiveSettings struct {
	Settings                  strategy.Settings
	GlobalEpoch, ProjectEpoch int64
}

func (s *Store) strategySettings(scope strategy.Scope) strategy.Settings {
	row := s.row("SELECT body FROM strategySettings WHERE scopeKey=?", strategyScopeKey(scope))
	if row == nil {
		return strategy.DefaultSettings(scope)
	}
	return strategyDecode[strategy.Settings](stringOf(row["body"]))
}
func (s *Store) GetStrategySettings(ctx StrategyContext, scope strategy.Scope) (strategy.Settings, error) {
	return strategyCall(s, false, func() strategy.Settings { s.strategyAuthorize(ctx, scope); return s.strategySettings(scope) })
}
func minStrategyBudget(a, b strategy.Budget) strategy.Budget {
	return strategy.Budget{ExtraReadRetries: min(a.ExtraReadRetries, b.ExtraReadRetries), MaxRevisions: min(a.MaxRevisions, b.MaxRevisions), MaxNoProgressRevisions: min(a.MaxNoProgressRevisions, b.MaxNoProgressRevisions), MaxConcurrentExperiments: min(a.MaxConcurrentExperiments, b.MaxConcurrentExperiments), MaxRuns: min(a.MaxRuns, b.MaxRuns), MaxOptimizationRequests: min(a.MaxOptimizationRequests, b.MaxOptimizationRequests), MaxAdditionalTokens: min(a.MaxAdditionalTokens, b.MaxAdditionalTokens), MaxActiveSeconds: min(a.MaxActiveSeconds, b.MaxActiveSeconds), UserWaitTTLSeconds: min(a.UserWaitTTLSeconds, b.UserWaitTTLSeconds)}
}
func (s *Store) strategyEffective(ctx StrategyContext) StrategyEffectiveSettings {
	s.strategyContext(ctx)
	global := s.strategySettings(strategy.Scope{Kind: strategy.UserScope})
	out := StrategyEffectiveSettings{Settings: global, GlobalEpoch: s.strategyGeneration("user")}
	if ctx.ProjectID != "" {
		scope := strategy.Scope{Kind: strategy.ProjectScope, ProjectID: ctx.ProjectID}
		project := s.strategySettings(scope)
		out.ProjectEpoch = s.strategyGeneration(strategyScopeKey(scope))
		if project.Revision > 0 {
			out.Settings.MasterEnabled = global.MasterEnabled && project.MasterEnabled
			out.Settings.ApplyEnabled = global.ApplyEnabled && project.ApplyEnabled
			out.Settings.LearnEnabled = global.LearnEnabled && project.LearnEnabled
			out.Settings.CorrectEnabled = global.CorrectEnabled && project.CorrectEnabled
			out.Settings.OnlineCorrectEnabled = global.OnlineCorrectEnabled && project.OnlineCorrectEnabled
			out.Settings.Budget = minStrategyBudget(global.Budget, project.Budget)
		}
	}
	if !out.Settings.MasterEnabled {
		out.Settings.ApplyEnabled = false
		out.Settings.LearnEnabled = false
		out.Settings.CorrectEnabled = false
	}
	if !out.Settings.CorrectEnabled {
		out.Settings.OnlineCorrectEnabled = false
	}
	return out
}
func (s *Store) EffectiveStrategySettings(ctx StrategyContext) (StrategyEffectiveSettings, error) {
	return strategyCall(s, false, func() StrategyEffectiveSettings { return s.strategyEffective(ctx) })
}
func (s *Store) strategyInvalidateJobs(where string, args ...any) {
	// An unknown/dispatched intent keeps its runtime identity and dispatchState.
	// Cancelling optimization never asserts that an external effect was undone.
	s.exec("UPDATE strategyJobs SET status='cancelled',leaseToken='',leaseUntilMs=0,errorCode='strategy_invalidated',updatedAt=? WHERE status IN ('queued','leased','awaiting_reconciliation') AND ("+where+")", append([]any{now()}, args...)...)
}
func (s *Store) strategySaveSettings(key string, value strategy.Settings) {
	s.exec("INSERT INTO strategySettings VALUES(?,?,?,?,?) ON CONFLICT(scopeKey) DO UPDATE SET revision=excluded.revision,epoch=excluded.epoch,body=excluded.body,updatedAt=excluded.updatedAt", key, value.Revision, value.Epoch, jsonText(value), now())
}
func (s *Store) SetStrategySettings(ctx StrategyContext, scope strategy.Scope, key string, expected int64, input StrategySettingsInput) (StrategyMutationResult, error) {
	return strategyCall(s, true, func() StrategyMutationResult {
		scopeKey := s.strategyEnsureScope(ctx, scope)
		if input.Budget.Validate() != nil {
			strategyFail(400, "invalid_budget")
		}
		result, replayed, digest := s.strategyReceipt(scopeKey, key, Object{"operation": "settings", "scope": scope, "expected": expected, "input": input})
		if replayed {
			return result
		}
		old := s.strategySettings(scope)
		if old.Revision != expected {
			strategyFail(409, "revision_conflict")
		}
		value := strategy.Settings{Scope: scope, Revision: old.Revision + 1, Epoch: s.strategyAdvanceScope(scopeKey), MasterEnabled: input.MasterEnabled, ApplyEnabled: input.ApplyEnabled, LearnEnabled: input.LearnEnabled, CorrectEnabled: input.CorrectEnabled, OnlineCorrectEnabled: input.OnlineCorrectEnabled, Budget: input.Budget}
		s.strategySaveSettings(scopeKey, value)
		if scope.Kind == strategy.UserScope {
			s.strategyInvalidateJobs("1=1")
		} else {
			s.strategyInvalidateJobs("accessProjectId=? OR scopeKey=?", scope.ProjectID, scopeKey)
		}
		s.strategyEvent(scopeKey, "", scopeKey, value.Revision, "settings_changed", value)
		result = StrategyMutationResult{SettingsRevision: value.Revision}
		s.strategySaveReceipt(scopeKey, key, digest, result)
		return result
	})
}

type StrategyBindingInput struct {
	Action           string
	Ref              strategy.RevisionRef
	ExpectedRevision int64
	Priority         int
	ExclusionGroup   string
}
type StrategyBinding struct {
	AssetID         string         `json:"assetId"`
	Scope           strategy.Scope `json:"scope"`
	Revision        int64          `json:"revision"`
	BindingRevision int64          `json:"bindingRevision"`
	Enabled         bool           `json:"enabled"`
	Priority        int            `json:"priority"`
	ExclusionGroup  string         `json:"exclusionGroup"`
}

func bindingFromRow(row Object) StrategyBinding {
	return StrategyBinding{stringOf(row["assetId"]), scopeFromRow(row), int64(integer(row["revision"])), int64(integer(row["bindingRevision"])), integer(row["enabled"]) != 0, integer(row["priority"]), stringOf(row["exclusionGroup"])}
}
func (s *Store) GetStrategyBinding(ctx StrategyContext, scope strategy.Scope, assetID string) (StrategyBinding, error) {
	return strategyCall(s, false, func() StrategyBinding {
		key := s.strategyAuthorize(ctx, scope)
		s.strategyAsset(ctx, assetID, true)
		row := s.row("SELECT * FROM strategyBindings WHERE assetId=? AND scopeKey=?", assetID, key)
		if row == nil {
			strategyFail(404, "binding_unavailable")
		}
		return bindingFromRow(row)
	})
}
func (s *Store) BindStrategyAsset(ctx StrategyContext, scope strategy.Scope, key string, input StrategyBindingInput) (StrategyMutationResult, error) {
	return strategyCall(s, true, func() StrategyMutationResult {
		target := s.strategyEnsureScope(ctx, scope)
		a := s.strategyAsset(ctx, input.Ref.AssetID, false)
		if scopeFromRow(a).Kind == strategy.ProjectScope && scopeFromRow(a) != scope {
			strategyFail(404, "asset_unavailable")
		}
		if input.Ref.Validate() != nil || input.Priority < 0 || input.Priority > 1000 || (input.ExclusionGroup != "" && !strategyTag.MatchString(input.ExclusionGroup)) {
			strategyFail(400, "invalid_binding")
		}
		result, replayed, digest := s.strategyReceipt(target, key, Object{"operation": "bind", "scope": scope, "input": input})
		if replayed {
			return result
		}
		prior := s.row("SELECT * FROM strategyBindings WHERE assetId=? AND scopeKey=?", input.Ref.AssetID, target)
		version := int64(0)
		if prior != nil {
			version = int64(integer(prior["bindingRevision"]))
		}
		if version != input.ExpectedRevision {
			strategyFail(409, "revision_conflict")
		}
		r := s.row("SELECT contentHash FROM strategyRevisions WHERE assetId=? AND revision=?", input.Ref.AssetID, input.Ref.Revision)
		if r == nil || r["contentHash"] != input.Ref.ContentHash {
			strategyFail(409, "revision_conflict")
		}
		enabled := true
		switch input.Action {
		case "adopt":
		case "revert":
			if prior == nil || input.Ref.Revision >= int64(integer(prior["revision"])) {
				strategyFail(400, "invalid_revert")
			}
		case "disable":
			enabled = false
			if prior == nil || input.Ref.Revision != int64(integer(prior["revision"])) {
				strategyFail(409, "revision_conflict")
			}
		default:
			strategyFail(400, "invalid_binding")
		}
		if enabled {
			view := s.strategyRevisionView(ctx, input.Ref.AssetID, input.Ref.Revision)
			if !view.Available || !view.SourcesAvailable {
				strategyFail(409, "source_unavailable")
			}
		}
		version++
		s.strategyAdvanceScope(target)
		s.exec("INSERT INTO strategyBindings VALUES(?,?,?,?,?,?,?) ON CONFLICT(assetId,scopeKey) DO UPDATE SET revision=excluded.revision,enabled=excluded.enabled,bindingRevision=excluded.bindingRevision,priority=excluded.priority,exclusionGroup=excluded.exclusionGroup", input.Ref.AssetID, target, input.Ref.Revision, enabled, version, input.Priority, input.ExclusionGroup)
		if enabled {
			node := "adoption:" + input.Ref.AssetID + ":" + strategy.ContentHash(target) + ":" + jsonText(version)
			s.strategyNode(node, target, "adoption", input.Ref.AssetID, input.Ref.Revision, nil)
			s.strategyEdge(input.Ref.AssetID, revisionNode(input.Ref.AssetID, input.Ref.Revision), node, "adopted_as")
		}
		if input.Action == "revert" {
			s.strategyEdge(input.Ref.AssetID, revisionNode(input.Ref.AssetID, int64(integer(prior["revision"]))), revisionNode(input.Ref.AssetID, input.Ref.Revision), "reverted_to")
		}
		s.strategyInvalidateJobs("assetId=?", input.Ref.AssetID)
		s.strategyEvent(target, "", input.Ref.AssetID, version, "binding_"+input.Action, input.Ref)
		result = StrategyMutationResult{AssetID: input.Ref.AssetID, Revision: input.Ref.Revision, BindingRevision: version}
		s.strategySaveReceipt(target, key, digest, result)
		return result
	})
}
func (s *Store) DeleteStrategyAsset(ctx StrategyContext, id, key string, expected int64) (StrategyMutationResult, error) {
	return strategyCall(s, true, func() StrategyMutationResult {
		a := s.strategyAsset(ctx, id, true)
		scopeKey := stringOf(a["scopeKey"])
		result, replayed, digest := s.strategyReceipt(scopeKey, key, Object{"operation": "delete_asset", "id": id, "expected": expected})
		if replayed {
			return result
		}
		if a["deletedAt"] != "" || expected != int64(integer(a["revision"])) {
			strategyFail(409, "revision_conflict")
		}
		s.strategyAdvanceScope(scopeKey)
		s.exec("UPDATE strategyAssets SET title='',deletedAt=? WHERE id=?", now(), id)
		s.strategyEraseAssetResults(id)
		s.exec("DELETE FROM strategyRevisionContent WHERE assetId=?", id)
		// A manual confirmation's body lives only in this asset's content rows.
		// Erasing it also removes that source's availability to other pending jobs.
		s.exec("UPDATE strategySourceEvents SET availability='tombstoned',summary='' WHERE kind='manual_authoring' AND id IN (SELECT sourceId FROM strategyRevisionSources WHERE assetId=?)", id)
		s.strategyInvalidateJobs("id IN (SELECT j.jobId FROM strategyJobSources j JOIN strategySourceEvents x ON x.id=j.sourceId WHERE x.availability<>'available')")
		s.exec("UPDATE strategyBindings SET enabled=0,bindingRevision=bindingRevision+1 WHERE assetId=?", id)
		s.strategyInvalidateJobs("assetId=?", id)
		s.strategyEvent(scopeKey, "", id, expected, "asset_deleted", Object{"id": id})
		result = StrategyMutationResult{AssetID: id, Revision: expected}
		s.strategySaveReceipt(scopeKey, key, digest, result)
		return result
	})
}

func (s *Store) strategyGeneration(key string) int64 {
	return int64(integer(s.row("SELECT generation FROM strategyScopes WHERE scopeKey=?", key)["generation"]))
}
func (s *Store) strategyAdvanceScope(key string) int64 {
	s.exec("UPDATE strategyScopes SET generation=generation+1 WHERE scopeKey=?", key)
	epoch := s.strategyGeneration(key)
	row := s.row("SELECT body FROM strategySettings WHERE scopeKey=?", key)
	if row != nil {
		settings := strategyDecode[strategy.Settings](stringOf(row["body"]))
		settings.Epoch = epoch
		s.strategySaveSettings(key, settings)
	}
	return epoch
}
func (s *Store) strategyArchiveProject(project string) {
	scope := strategy.Scope{Kind: strategy.ProjectScope, ProjectID: project}
	key := s.strategyEnsureScope(StrategyContext{ProjectID: project}, scope)
	s.strategyAdvanceScope(key)
	s.strategyInvalidateJobs("accessProjectId=? OR scopeKey=?", project, key)
	s.strategyEvent(key, project, key, s.strategyGeneration(key), "scope_revoked", Object{"projectId": project})
}
