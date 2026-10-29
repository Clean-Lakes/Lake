package web

// Historical fixture support only: never compiled into the Lake product.

import (
	"time"

	"github.com/Clean-Lakes/Lake/internal/testsupport/legacystrategy"

	"github.com/Clean-Lakes/Lake/internal/strategy"
)

func (s *Store) strategyDefaultReuse(kind strategy.AssetKind) legacystrategy.ReusePolicy {
	// Preserve explicitly adopted legacy report/preferences. Legacy procedures
	// have no trustworthy conditions, so require review before automatic reuse.
	if kind == strategy.UserPreference || kind == strategy.ReportGuidance {
		return legacystrategy.ReusePolicy{Keywords: []string{}, General: true}
	}
	return legacystrategy.ReusePolicy{Keywords: []string{}, NeedsReview: true}
}

func (s *Store) strategyReusePolicy(id string, revision int64, kind strategy.AssetKind) (legacystrategy.ReusePolicy, string, map[string]string) {
	row := s.row("SELECT * FROM strategyReusePolicies WHERE assetId=? AND revision=?", id, revision)
	if row == nil {
		return s.strategyDefaultReuse(kind), "", nil
	}
	policy := strategyDecode[legacystrategy.ReusePolicy](stringOf(row["body"]))
	if policy.Keywords == nil {
		policy.Keywords = []string{}
	}
	return policy, stringOf(row["modelHash"]), strategyDecode[map[string]string](stringOf(row["toolHashes"]))
}

func strategyReuseReason(policy legacystrategy.ReusePolicy, kind strategy.AssetKind, model string, tools map[string]string, q legacystrategy.SelectionQuery) string {
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
