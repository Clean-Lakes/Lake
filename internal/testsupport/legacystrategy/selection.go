package legacystrategy

import (
	"encoding/json"
	"sort"
)

type Candidate struct {
	Value             AssetRevision
	Priority          int
	ExclusionGroup    string
	UnavailableReason string
	Reuse             ReusePolicy
}
type SelectionQuery struct {
	Profile       string
	ResourceKinds []string
	// Tags must be explicitly supplied by a trusted host, never inferred by a model.
	DomainTags       []string
	SkillReadAllowed bool
	TaskText         string
	ModelHash        string
	ToolHash         string
}
type ResolvedSelection struct {
	Selection Selection
	Assets    []AssetRevision
}

func intersects(required, actual []string) bool {
	if len(required) == 0 {
		return true
	}
	for _, a := range required {
		for _, b := range actual {
			if a == b {
				return true
			}
		}
	}
	return false
}

// Resolve is deterministic and has no I/O. Priority affects order/budget only;
// an unresolved exclusion group suppresses all its members.
func Resolve(candidates []Candidate, q SelectionQuery, maxBytes int) ResolvedSelection {
	candidates = append([]Candidate(nil), candidates...)
	scores := map[string]int{}
	matched := map[string]string{}
	for _, c := range candidates {
		score, reason := c.Reuse.Relevance(q.TaskText)
		if q.TaskText == "" {
			reason = "explicit_scope"
		}
		scores[c.Value.Ref.AssetID] = score
		matched[c.Value.Ref.AssetID] = reason
	}
	sort.Slice(candidates, func(i, j int) bool {
		a, b := candidates[i], candidates[j]
		if scores[a.Value.Ref.AssetID] != scores[b.Value.Ref.AssetID] {
			return scores[a.Value.Ref.AssetID] > scores[b.Value.Ref.AssetID]
		}
		if a.Priority != b.Priority {
			return a.Priority > b.Priority
		}
		return a.Value.Ref.AssetID < b.Value.Ref.AssetID
	})
	maxBytes = min(maxBytes, MaxAssetPromptBytes)
	out := ResolvedSelection{Selection: Selection{Selected: []RevisionRef{}, Omitted: []OmittedAsset{}}, Assets: []AssetRevision{}}
	reasons := make([]string, len(candidates))
	groups := map[string]int{}
	for i, c := range candidates {
		reason := c.UnavailableReason
		if reason == "" && (!intersects(c.Value.Applicability.Profiles, []string{q.Profile}) || !intersects(c.Value.Applicability.ResourceKinds, q.ResourceKinds) || !intersects(c.Value.Applicability.DomainTags, q.DomainTags)) {
			reason = "not_applicable"
		}
		if reason == "" && q.TaskText != "" && matched[c.Value.Ref.AssetID] == "not_relevant" {
			reason = "not_relevant"
		}
		reasons[i] = reason
		if reason == "" && c.ExclusionGroup != "" {
			groups[c.ExclusionGroup]++
		}
	}
	hashes := map[string]bool{}
	for i, c := range candidates {
		reason := reasons[i]
		if reason == "" && c.ExclusionGroup != "" && groups[c.ExclusionGroup] > 1 {
			reason = "exclusion_conflict"
		}
		if reason == "" && hashes[ContentHash(ComparableContent(c.Value.Body))] {
			reason = "duplicate_content"
		}
		if reason == "" && len(out.Assets) >= MaxSelectedAssets {
			reason = "asset_count"
		}
		cost := AssetPromptCost(c.Value)
		if reason == "" && cost > maxBytes {
			reason = "asset_budget"
		}
		if reason != "" {
			out.Selection.Omitted = append(out.Selection.Omitted, OmittedAsset{Ref: c.Value.Ref, Reason: reason})
			continue
		}
		hashes[ContentHash(ComparableContent(c.Value.Body))] = true
		maxBytes -= cost
		out.Assets = append(out.Assets, c.Value)
		out.Selection.Selected = append(out.Selection.Selected, c.Value.Ref)
		out.Selection.Reasons = append(out.Selection.Reasons, SelectionReason{Ref: c.Value.Ref, Reason: matched[c.Value.Ref.AssetID], Score: scores[c.Value.Ref.AssetID]})
	}
	return out
}

// AssetPromptCost includes JSON escaping, references and a conservative share
// of the fixed data envelope, rather than counting only raw body bytes.
func AssetPromptCost(value AssetRevision) int { raw, _ := json.Marshal(value); return len(raw)*2 + 512 }
