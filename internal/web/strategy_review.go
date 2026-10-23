package web

import (
	"github.com/Clean-Lakes/Lake/internal/strategy"
	"strings"
)

type StrategyReview struct {
	Decision         string `json:"decision"`
	DecisionRevision int64  `json:"decisionRevision"`
	ReasonCode       string `json:"reasonCode"`
}

func (s *Store) strategyReview(id string, revision int64) StrategyReview {
	if row := s.row("SELECT * FROM strategyReviews WHERE assetId=? AND revision=?", id, revision); row != nil {
		return StrategyReview{stringOf(row["decision"]), int64(integer(row["decisionRevision"])), stringOf(row["reasonCode"])}
	}
	r := s.row("SELECT createdBy FROM strategyRevisions WHERE assetId=? AND revision=?", id, revision)
	decision := "accepted"
	if strings.HasPrefix(stringOf(r["createdBy"]), "job:") || strings.HasPrefix(stringOf(r["createdBy"]), "optimizer:") {
		decision = "pending"
	}
	return StrategyReview{Decision: decision}
}
func (s *Store) ReviewStrategyRevision(ctx StrategyContext, id, key string, ref strategy.RevisionRef, expected int64, decision, reason string) (StrategyMutationResult, error) {
	return strategyCall(s, true, func() StrategyMutationResult {
		a := s.strategyAsset(ctx, id, false)
		if scopeFromRow(a).Kind == strategy.UserScope && ctx.ProjectID != "" {
			strategyFail(404, "asset_unavailable")
		}
		if ref.AssetID != id || ref.Validate() != nil || (decision != "accepted" && decision != "rejected") || !set("not_reusable duplicate incorrect too_specific other reviewed")[reason] {
			strategyFail(400, "invalid_review")
		}
		result, replay, digest := s.strategyReceipt(stringOf(a["scopeKey"]), key, Object{"operation": "review", "ref": ref, "expected": expected, "decision": decision, "reason": reason})
		if replay {
			return result
		}
		v := s.strategyRevisionView(ctx, id, ref.Revision)
		if v.Value.Ref != ref || v.Review.DecisionRevision != expected || int64(integer(a["revision"])) != ref.Revision {
			strategyFail(409, "revision_conflict")
		}
		if !v.Available || !v.SourcesAvailable {
			strategyFail(409, "source_unavailable")
		}
		s.exec("INSERT INTO strategyReviews VALUES(?,?,?,?,?,?) ON CONFLICT(assetId,revision) DO UPDATE SET decision=excluded.decision,decisionRevision=excluded.decisionRevision,reasonCode=excluded.reasonCode,updatedAt=excluded.updatedAt", id, ref.Revision, decision, expected+1, reason, now())
		if decision == "rejected" {
			r := s.row("SELECT sourceSetHash FROM strategyRevisions WHERE assetId=? AND revision=?", id, ref.Revision)
			s.exec("INSERT OR IGNORE INTO strategyRejections VALUES(?,?,?,?,?)", a["scopeKey"], r["sourceSetHash"], strategy.ContentHash(strategyComparableBody(v.Value.Body)), reason, now())
			s.exec("UPDATE strategyBindings SET enabled=0,bindingRevision=bindingRevision+1 WHERE assetId=? AND revision=?", id, ref.Revision)
			s.strategyAdvanceScope(stringOf(a["scopeKey"]))
			s.pruneStrategyDerivedContent()
		}
		s.strategyEvent(stringOf(a["scopeKey"]), "", id, expected+1, "review_"+decision, ref)
		result = StrategyMutationResult{AssetID: id, Revision: ref.Revision}
		s.strategySaveReceipt(stringOf(a["scopeKey"]), key, digest, result)
		return result
	})
}

// Internal availability lookup returns a boolean only. Never expose the original
// project's identifiers/text through a global revision, export or model prompt.
func (s *Store) strategyPromotionAvailable(id string, revision int64) bool {
	link := s.row("SELECT * FROM strategyPromotions WHERE assetId=? AND revision=?", id, revision)
	if link == nil {
		return true
	}
	a := s.row("SELECT a.*,r.contentHash FROM strategyAssets a JOIN strategyRevisions r ON r.assetId=a.id AND r.revision=? WHERE a.id=?", link["originRevision"], link["originAssetId"])
	if a == nil || a["deletedAt"] != "" || a["contentHash"] != link["originHash"] || a["scopeKey"] == "user" || s.strategyReview(stringOf(a["id"]), int64(integer(link["originRevision"]))).Decision != "accepted" {
		return false
	}
	project := strings.TrimPrefix(stringOf(a["scopeKey"]), "project:")
	if s.row("SELECT id FROM projects WHERE id=? AND "+activeProjectsSQL, project) == nil {
		return false
	}
	if s.row("SELECT 1 FROM strategyRevisionContent WHERE assetId=? AND revision=?", a["id"], link["originRevision"]) == nil {
		return false
	}
	for _, row := range s.rows("SELECT sourceId FROM strategyRevisionSources WHERE assetId=? AND revision=?", a["id"], link["originRevision"]) {
		if s.strategySource(StrategyContext{ProjectID: project}, stringOf(row["sourceId"]), false)["availability"] != "available" {
			return false
		}
	}
	return true
}
func (s *Store) PromoteStrategyRevision(ctx StrategyContext, id, key string, ref strategy.RevisionRef, in StrategyAssetInput, confirmed bool) (StrategyMutationResult, error) {
	return strategyCall(s, true, func() StrategyMutationResult {
		a := s.strategyAsset(ctx, id, false)
		if ctx.ProjectID == "" || scopeFromRow(a).Kind != strategy.ProjectScope || !confirmed || ref.AssetID != id || ref.Validate() != nil {
			strategyFail(400, "promotion_requires_confirmation")
		}
		validateStrategyInput(in)
		result, replay, digest := s.strategyReceipt(stringOf(a["scopeKey"]), key, Object{"operation": "promote", "ref": ref, "input": in, "confirmed": confirmed})
		if replay {
			return result
		}
		v := s.strategyRevisionView(ctx, id, ref.Revision)
		if v.Value.Ref != ref || int64(integer(a["revision"])) != ref.Revision {
			strategyFail(409, "revision_conflict")
		}
		if !v.Available || !v.SourcesAvailable || v.Review.Decision != "accepted" {
			strategyFail(409, "review_required")
		}
		if in.Kind != v.Value.Kind || strings.TrimSpace(in.Assessment.Conditions) == "" || strings.TrimSpace(in.Assessment.Limitations) == "" {
			strategyFail(400, "promotion_conditions_required")
		}
		if s.row("SELECT 1 FROM strategyPromotions p JOIN strategyAssets a ON a.id=p.assetId JOIN strategyRevisions r ON r.assetId=p.assetId AND r.revision=p.revision WHERE p.originAssetId=? AND p.originRevision=? AND a.deletedAt='' AND r.contentHash=?", id, ref.Revision, strategy.ContentHash(in.Body)) != nil {
			strategyFail(409, "duplicate_promotion")
		}
		target := ident()
		s.exec("INSERT INTO strategyAssets(id,scopeKey,kind,title,revision,createdAt) VALUES(?,'user',?,?,1,?)", target, in.Kind, in.Title, now())
		source := s.strategyManualSource("user", "promotion:"+target, in.Body)
		s.strategyWriteRevision(StrategyContext{}, s.strategyAsset(StrategyContext{}, target, false), 1, 0, in, []string{source}, strategy.UserConfirmed, "local_user")
		s.exec("INSERT INTO strategyPromotions VALUES(?,1,?,?,?)", target, id, ref.Revision, ref.ContentHash)
		s.strategyEdge(target, revisionNode(target, 1), revisionNode(id, ref.Revision), "derived_from")
		s.strategyEvent("user", "", target, 1, "promoted", Object{"ref": strategy.RevisionRef{AssetID: target, Revision: 1, ContentHash: strategy.ContentHash(in.Body)}})
		result = StrategyMutationResult{AssetID: target, Revision: 1}
		s.strategySaveReceipt(stringOf(a["scopeKey"]), key, digest, result)
		return result
	})
}
func (s *Store) pruneStrategyDerivedContent() {
	// Erase optional candidate copies after explicit source revocation; immutable
	// references, hashes, decisions and adoption audit remain as tombstones.
	for _, r := range s.rows("SELECT DISTINCT rs.assetId,rs.revision,a.scopeKey FROM strategyRevisionSources rs JOIN strategySourceEvents x ON x.id=rs.sourceId JOIN strategyAssets a ON a.id=rs.assetId JOIN strategyRevisionContent c ON c.assetId=rs.assetId AND c.revision=rs.revision WHERE x.availability<>'available'") {
		s.exec("DELETE FROM strategyRevisionContent WHERE assetId=? AND revision=?", r["assetId"], r["revision"])
		s.exec("DELETE FROM strategyAssessments WHERE assetId=? AND revision=?", r["assetId"], r["revision"])
		s.exec("UPDATE strategyBindings SET enabled=0,bindingRevision=bindingRevision+1 WHERE assetId=? AND revision=?", r["assetId"], r["revision"])
		s.strategyEraseAssetResults(stringOf(r["assetId"]))
		s.strategyAdvanceScope(stringOf(r["scopeKey"]))
	}

	for _, link := range s.rows("SELECT p.* FROM strategyPromotions p JOIN strategyRevisionContent c ON c.assetId=p.assetId AND c.revision=p.revision") {
		id, revision := stringOf(link["assetId"]), int64(integer(link["revision"]))
		if s.strategyPromotionAvailable(id, revision) {
			continue
		}
		s.exec("DELETE FROM strategyRevisionContent WHERE assetId=? AND revision=?", id, revision)
		s.exec("DELETE FROM strategyAssessments WHERE assetId=? AND revision=?", id, revision)
		s.exec("UPDATE strategyBindings SET enabled=0,bindingRevision=bindingRevision+1 WHERE assetId=? AND revision=?", id, revision)
		s.strategyEraseAssetResults(id)
		s.strategyAdvanceScope("user")
	}
}
