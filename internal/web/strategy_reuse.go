package web

import (
	"github.com/Clean-Lakes/Lake/internal/ai"
	"github.com/Clean-Lakes/Lake/internal/strategy"
	"time"
)

func (s *Store) strategyDefaultReuse(kind strategy.AssetKind) strategy.ReusePolicy {
	// Preserve explicitly adopted legacy report/preferences. Legacy procedures
	// have no trustworthy conditions, so require review before automatic reuse.
	if kind == strategy.UserPreference || kind == strategy.ReportGuidance {
		return strategy.ReusePolicy{Keywords: []string{}, General: true}
	}
	return strategy.ReusePolicy{Keywords: []string{}, NeedsReview: true}
}
func (s *Store) strategyReusePolicy(id string, revision int64, kind strategy.AssetKind) (strategy.ReusePolicy, string, map[string]string) {
	row := s.row("SELECT * FROM strategyReusePolicies WHERE assetId=? AND revision=?", id, revision)
	if row == nil {
		return s.strategyDefaultReuse(kind), "", nil
	}
	policy := strategyDecode[strategy.ReusePolicy](stringOf(row["body"]))
	if policy.Keywords == nil {
		policy.Keywords = []string{}
	}
	return policy, stringOf(row["modelHash"]), strategyDecode[map[string]string](stringOf(row["toolHashes"]))
}
func (b *Server) strategyCaptureReuse(in StrategyAssetInput) StrategyAssetInput {
	if model := b.Models.Active(); model != nil {
		in.ModelHash = ai.StrategyReuseModelHash(*model)
	}
	in.ToolHashes = map[string]string{}
	for _, profile := range []string{"core", "terminal2", "db-query-editor"} {
		in.ToolHashes[profile] = strategy.ContentHash(jsonText(ai.Catalog(profile)))
	}
	return in
}
func strategyReuseReason(policy strategy.ReusePolicy, kind strategy.AssetKind, model string, tools map[string]string, q strategy.SelectionQuery) string {
	if policy.NeedsReview {
		return "review_required"
	}
	if policy.ValidUntil != "" {
		until, err := time.Parse(time.RFC3339, policy.ValidUntil)
		if err != nil || !time.Now().Before(until) {
			return "expired"
		}
	}
	if kind == strategy.DomainProcedure || kind == strategy.ToolGuidance {
		if q.ModelHash != "" && (model == "" || model != q.ModelHash) {
			return "model_changed"
		}
		if q.ToolHash != "" && (tools[q.Profile] == "" || tools[q.Profile] != q.ToolHash) {
			return "tools_changed"
		}
	}
	return ""
}
func (s *Store) StrategyUsageFeedback(ctx StrategyContext, key, sessionID, requestID string, ref strategy.RevisionRef, expected int64, outcome string, suspend bool) (StrategyMutationResult, error) {
	return strategyCall(s, true, func() StrategyMutationResult {
		s.strategyContext(ctx)
		if ctx.ProjectID == "" || s.session(sessionID)["projectId"] != ctx.ProjectID {
			strategyFail(404, "usage_unavailable")
		}
		s.strategyAsset(ctx, ref.AssetID, true)
		r := s.row("SELECT contentHash FROM strategyRevisions WHERE assetId=? AND revision=?", ref.AssetID, ref.Revision)
		if ref.Validate() != nil || r == nil || r["contentHash"] != ref.ContentHash || !set("helpful neutral harmful not_used")[outcome] || (suspend && outcome != "harmful") {
			strategyFail(400, "invalid_feedback")
		}
		scope := s.strategyEnsureScope(ctx, strategy.Scope{Kind: strategy.ProjectScope, ProjectID: ctx.ProjectID})
		result, replay, digest := s.strategyReceipt(scope, key, Object{"op": "usage_feedback", "sessionId": sessionID, "requestId": requestID, "ref": ref, "expected": expected, "outcome": outcome, "suspend": suspend})
		if replay {
			return result
		}
		old := s.row("SELECT feedbackRevision FROM strategyUsageFeedback WHERE projectId=? AND sessionId=? AND requestId=? AND assetId=? AND revision=?", ctx.ProjectID, sessionID, requestID, ref.AssetID, ref.Revision)
		if int64(integer(old["feedbackRevision"])) != expected {
			strategyFail(409, "feedback_conflict")
		}
		s.exec(`INSERT INTO strategyUsageFeedback VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(projectId,sessionId,requestId,assetId,revision) DO UPDATE SET outcome=excluded.outcome,feedbackRevision=excluded.feedbackRevision,updatedAt=excluded.updatedAt`, ctx.ProjectID, sessionID, requestID, ref.AssetID, ref.Revision, ref.ContentHash, outcome, expected+1, now())
		if suspend {
			prior := s.row("SELECT * FROM strategyBindings WHERE assetId=? AND scopeKey=?", ref.AssetID, scope)
			effective := prior
			if effective == nil {
				effective = s.row("SELECT * FROM strategyBindings WHERE assetId=? AND scopeKey='user'", ref.AssetID)
			}
			if effective == nil || int64(integer(effective["revision"])) != ref.Revision {
				strategyFail(409, "binding_changed")
			}
			s.exec("INSERT INTO strategyBindings VALUES(?,?,?,0,?,?,?) ON CONFLICT(assetId,scopeKey) DO UPDATE SET revision=excluded.revision,enabled=0,bindingRevision=excluded.bindingRevision", ref.AssetID, scope, ref.Revision, integer(prior["bindingRevision"])+1, integer(effective["priority"]), stringOf(effective["exclusionGroup"]))
			s.strategyAdvanceScope(scope)
			s.strategyInvalidateJobs("assetId=? AND accessProjectId=?", ref.AssetID, ctx.ProjectID)
		}
		s.strategyEvent(scope, ctx.ProjectID, ref.AssetID, expected+1, "usage_feedback", Object{"requestId": requestID, "ref": ref, "outcome": outcome, "suspend": suspend})
		result = StrategyMutationResult{AssetID: ref.AssetID, Revision: ref.Revision}
		s.strategySaveReceipt(scope, key, digest, result)
		return result
	})
}

func (b *Server) strategyRevisionReuseStatus(v StrategyRevisionView) string {
	return strategyMust(strategyCall(b.Store, false, func() string {
		policy, model, tools := b.Store.strategyReusePolicy(v.Asset.ID, v.Value.Ref.Revision, v.Value.Kind)
		profile := "core"
		if len(v.Value.Applicability.Profiles) > 0 {
			profile = v.Value.Applicability.Profiles[0]
		}
		q := strategy.SelectionQuery{Profile: profile, ToolHash: strategy.ContentHash(jsonText(ai.Catalog(profile)))}
		if active := b.Models.Active(); active != nil {
			q.ModelHash = ai.StrategyReuseModelHash(*active)
		}
		return strategyReuseReason(policy, v.Value.Kind, model, tools, q)
	}))
}
