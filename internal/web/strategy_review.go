package web

import (
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

func (s *Store) pruneStrategyDerivedContent() {
	// Erase optional candidate copies after explicit source revocation; immutable
	// references, hashes, decisions and adoption audit remain as tombstones.
	for _, r := range s.rows("SELECT DISTINCT rs.assetId,rs.revision,a.scopeKey FROM strategyRevisionSources rs JOIN strategySourceEvents x ON x.id=rs.sourceId JOIN strategyAssets a ON a.id=rs.assetId JOIN strategyRevisionContent c ON c.assetId=rs.assetId AND c.revision=rs.revision WHERE x.availability<>'available'") {
		s.exec("DELETE FROM strategyRevisionContent WHERE assetId=? AND revision=?", r["assetId"], r["revision"])
		s.exec("DELETE FROM strategyAssessments WHERE assetId=? AND revision=?", r["assetId"], r["revision"])
		s.exec("DELETE FROM strategyReusePolicies WHERE assetId=? AND revision=?", r["assetId"], r["revision"])
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
		s.exec("DELETE FROM strategyReusePolicies WHERE assetId=? AND revision=?", id, revision)
		s.exec("UPDATE strategyBindings SET enabled=0,bindingRevision=bindingRevision+1 WHERE assetId=? AND revision=?", id, revision)
		s.strategyEraseAssetResults(id)
		s.strategyAdvanceScope("user")
	}
}
