package web

import (
	"context"
	"errors"
	"reflect"
	"strings"

	"github.com/Clean-Lakes/Lake/internal/strategy"
)

func (b *Server) strategyCorrectionGuard(ctx context.Context, id string, globalEpoch, projectEpoch int64) (err error) {
	defer func() {
		if recover() != nil {
			err = errors.New("strategy correction context unavailable")
		}
	}()
	if err = ctx.Err(); err != nil {
		return err
	}
	session := b.Store.Session(id)
	project := stringOf(session["projectId"])
	if project == "" {
		return errors.New("strategy correction project unavailable")
	}
	effective, err := b.Store.EffectiveStrategySettings(StrategyContext{ProjectID: project})
	if err != nil {
		return err
	}
	if !effective.Settings.MasterEnabled || !effective.Settings.CorrectEnabled || !effective.Settings.OnlineCorrectEnabled || effective.GlobalEpoch != globalEpoch || effective.ProjectEpoch != projectEpoch {
		return errors.New("策略纠错设置已变化；本轮停止，请重新发送")
	}
	return nil
}

// resolveStrategyBindings runs under the repository read lock. A project
// binding, including an explicit disable, shadows the same global asset.
func (s *Store) resolveStrategyBindings(ctx StrategyContext, q strategy.SelectionQuery, frozen *strategy.Selection, skillCheck func(string, string) bool) (strategy.ResolvedSelection, error) {
	return strategyCall(s, false, func() strategy.ResolvedSelection {
		effective := s.strategyEffective(ctx)
		result := strategy.ResolvedSelection{Selection: strategy.Selection{GlobalEpoch: effective.GlobalEpoch, ProjectEpoch: effective.ProjectEpoch, SettingsRevision: effective.Settings.Revision, Selected: []strategy.RevisionRef{}, Omitted: []strategy.OmittedAsset{}}, Assets: []strategy.AssetRevision{}}
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
			candidates := []strategy.Candidate{}
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
				candidates = append(candidates, strategy.Candidate{Reuse: policy, Value: v.Value, Priority: integer(row["priority"]), ExclusionGroup: stringOf(row["exclusionGroup"]), UnavailableReason: reason})
			}
			resolved := strategy.Resolve(candidates, q, strategy.MaxAssetPromptBytes)
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
func (b *Server) strategyProvider(ctx context.Context, id string, q strategy.SelectionQuery, frozen *strategy.Selection) (out strategy.ResolvedSelection, err error) {
	// Store.Session and credential adapters use host panics for unavailable data.
	// Never let those escape into the provider/SDK callback or expose raw errors.
	defer func() {
		if recover() != nil {
			out = strategy.ResolvedSelection{}
			err = &StrategyError{404, "strategy_context_unavailable"}
		}
	}()
	if ctx.Err() != nil {
		return strategy.ResolvedSelection{}, ctx.Err()
	}
	// Resolve from the authenticated host session, not a config/model project ID.
	session := b.Store.Session(id)
	project := stringOf(session["projectId"])
	if project == "" {
		return strategy.ResolvedSelection{}, errors.New("strategy session unavailable")
	}
	checked := map[string]bool{}
	out, err = b.Store.resolveStrategyBindings(StrategyContext{ProjectID: project}, q, frozen, func(name, hash string) bool {
		key := name + ":" + hash
		if value, ok := checked[key]; ok {
			return value
		}
		meta, body, err := b.Extensions.Store.ReadSkill(name, "")
		value := err == nil && meta.Enabled && strategy.ContentHash(body) == hash
		checked[key] = value
		return value
	})
	if err != nil {
		return strategy.ResolvedSelection{}, err
	}
	// A historical preference can become sensitive after credentials change.
	// Recheck current configured secrets, including inactive model providers.
	for _, asset := range out.Assets {
		if b.Terminals.containsCredential(asset.Body) || b.Models.strategyContainsProviderSecret(asset.Body) {
			return strategy.ResolvedSelection{}, &StrategyError{400, "strategy_sensitive_content"}
		}
	}
	return out, nil
}

// ImportStrategySkill accepts only a trusted host-read snapshot. HTTP callers
// choose a catalog name, never a path/hash/source ID or verification level.
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
