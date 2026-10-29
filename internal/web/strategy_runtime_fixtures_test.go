package web

// Historical fixture support only: never compiled into the Lake product.

import (
	"reflect"
	"strings"

	"github.com/Clean-Lakes/Lake/internal/testsupport/legacystrategy"

	"github.com/Clean-Lakes/Lake/internal/strategy"
)

// resolveStrategyBindings runs under the repository read lock. A project
// binding, including an explicit disable, shadows the same global asset.
func (s *Store) resolveStrategyBindings(ctx StrategyContext, q legacystrategy.SelectionQuery, frozen *strategy.Selection, skillCheck func(string, string) bool) (legacystrategy.ResolvedSelection, error) {
	return strategyCall(s, false, func() legacystrategy.ResolvedSelection {
		effective := s.strategyEffective(ctx)
		result := legacystrategy.ResolvedSelection{Selection: strategy.Selection{GlobalEpoch: effective.GlobalEpoch, ProjectEpoch: effective.ProjectEpoch, SettingsRevision: effective.Settings.Revision, Selected: []strategy.RevisionRef{}, Omitted: []strategy.OmittedAsset{}}, Assets: []strategy.AssetRevision{}}
		if ctx.ProjectID != "" {
			result.Selection.ProjectSettingsRevision = s.strategySettings(strategy.Scope{Kind: strategy.ProjectScope, ProjectID: ctx.ProjectID}).Revision
		}
		if frozen != nil && len(frozen.Selected) == 0 {
			// No asset was injected. Do not introduce a newly adopted asset into
			// an existing turn, or stop ordinary work for a learning epoch change.
			result.Selection = *frozen
			return result
		}
		if effective.Settings.MasterEnabled && effective.Settings.ApplyEnabled {
			rows := s.rows(`SELECT b.* FROM strategyBindings b JOIN strategyAssets a ON a.id=b.assetId
    WHERE a.deletedAt='' AND (b.scopeKey='user' OR b.scopeKey=?)
    AND NOT (b.scopeKey='user' AND EXISTS (SELECT 1 FROM strategyBindings p WHERE p.assetId=b.assetId AND p.scopeKey=?))
    ORDER BY b.priority DESC,b.assetId LIMIT 201`, "project:"+ctx.ProjectID, "project:"+ctx.ProjectID)
			if len(rows) > 200 {
				strategyFail(409, "binding_limit")
			}
			candidates := []legacystrategy.Candidate{}
			for _, row := range rows {
				v := s.strategyRevisionView(ctx, stringOf(row["assetId"]), int64(integer(row["revision"])))
				reason := ""
				if q.Profile == "isolated_role" {
					reason = "unsupported_context"
				}
				if !v.Available || !v.SourcesAvailable {
					reason = "source_unavailable"
				} else if v.Review.Decision == "rejected" {
					reason = "rejected"
				} else if integer(row["enabled"]) == 0 {
					reason = "disabled"
				}

				for _, source := range s.strategyRuntimeSources(ctx, v.Value.Ref) {
					if source["kind"] == "skill_import" {
						parts := strings.Split(stringOf(source["originKey"]), ":")
						if !q.SkillReadAllowed {
							reason = "skill_read_permission_required"
						} else if len(parts) != 4 || skillCheck == nil || !skillCheck(parts[1], stringOf(source["contentHash"])) {
							reason = "skill_source_changed"
						}
					}
				}
				policy, model, toolHashes := s.strategyReusePolicy(v.Value.Ref.AssetID, v.Value.Ref.Revision, v.Value.Kind)
				if reason == "" {
					reason = strategyReuseReason(policy, v.Value.Kind, model, toolHashes, q)
				}
				candidates = append(candidates, legacystrategy.Candidate{Reuse: policy, Value: v.Value, Priority: integer(row["priority"]), ExclusionGroup: stringOf(row["exclusionGroup"]), UnavailableReason: reason})
			}
			resolved := legacystrategy.Resolve(candidates, q, legacystrategy.MaxAssetPromptBytes)
			result.Assets = resolved.Assets
			result.Selection.Selected = resolved.Selection.Selected
			result.Selection.Omitted = resolved.Selection.Omitted
			result.Selection.Reasons = resolved.Selection.Reasons
		}
		if frozen != nil && !reflect.DeepEqual(result.Selection.Selected, frozen.Selected) {
			strategyFail(409, "turn_invalidated")
		}
		if frozen != nil {
			// The exact adopted revisions and current source permissions still
			// match. Learning settings may change without revoking this context.
			result.Selection = *frozen
		}
		return result
	})
}

func (s *Store) importStrategySkill(ctx StrategyContext, scope strategy.Scope, key, name, body string, in StrategyAssetInput) (StrategyMutationResult, error) {
	return strategyCall(s, true, func() StrategyMutationResult {
		scopeKey := s.strategyEnsureScope(ctx, scope)
		validateStrategyInput(in)
		if in.Body != body {
			strategyFail(400, "invalid_import")
		}
		result, replayed, digest := s.strategyReceipt(scopeKey, key, Object{"operation": "import_skill", "name": name, "hash": strategy.ContentHash(body), "input": in})
		if replayed {
			return result
		}
		id := ident()
		s.exec("INSERT INTO strategyAssets(id,scopeKey,kind,title,revision,createdAt) VALUES(?,?,?,?,1,?)", id, scopeKey, in.Kind, in.Title, now())
		source := ident()
		s.exec("INSERT INTO strategySourceEvents VALUES(?,?,?,'skill_import','','',?,'User-selected Skill snapshot','available',?)", source, scopeKey, "skill:"+name+":"+strategy.ContentHash(body)+":"+id, strategy.ContentHash(body), now())
		s.strategyNode("source:"+source, scopeKey, "user_message", "", 0, source)
		s.strategyWriteRevision(ctx, s.strategyAsset(ctx, id, false), 1, 0, in, []string{source}, strategy.UserConfirmed, "local_user")
		result = StrategyMutationResult{AssetID: id, Revision: 1, SourceID: source}
		s.strategySaveReceipt(scopeKey, key, digest, result)
		return result
	})
}

// Private promotion dependencies are checked by the host, never copied into the
// global revision/API/prompt. Skill permissions and source hashes still apply.
func (s *Store) strategyRuntimeSources(ctx StrategyContext, ref strategy.RevisionRef) []Object {
	out := []Object{}
	if !s.strategyPromotionAvailable(ref.AssetID, ref.Revision) {
		return out
	}
	for _, row := range s.rows(`SELECT x.* FROM strategySourceEvents x JOIN strategyRevisionSources rs ON rs.sourceId=x.id WHERE rs.assetId=? AND rs.revision=?
 UNION SELECT x.* FROM strategyPromotions p JOIN strategyRevisionSources rs ON rs.assetId=p.originAssetId AND rs.revision=p.originRevision JOIN strategySourceEvents x ON x.id=rs.sourceId WHERE p.assetId=? AND p.revision=?`, ref.AssetID, ref.Revision, ref.AssetID, ref.Revision) {
		scope := scopeFromRow(row)
		sourceContext := ctx
		if scope.Kind == strategy.ProjectScope {
			sourceContext = StrategyContext{ProjectID: scope.ProjectID}
		}
		out = append(out, s.strategySource(sourceContext, stringOf(row["id"]), false))
	}
	return out
}
