package strategy

import (
	"encoding/json"
	"sort"
)

// Selection is a body-free, turn-frozen reference set. Epochs fence any change
// to adoption, settings or source visibility before the next request/tool.
type Selection struct {
	GlobalEpoch             int64          `json:"globalEpoch"`
	ProjectEpoch            int64          `json:"projectEpoch"`
	SettingsRevision        int64          `json:"settingsRevision"`
	ProjectSettingsRevision int64          `json:"projectSettingsRevision"`
	Selected                []RevisionRef  `json:"selected"`
	Omitted                 []OmittedAsset `json:"omitted"`
}
type Candidate struct {
	Value             AssetRevision
	Priority          int
	ExclusionGroup    string
	UnavailableReason string
}
type SelectionQuery struct {
	Profile       string
	ResourceKinds []string
	// Tags must be explicitly supplied by a trusted host, never inferred by a model.
	DomainTags       []string
	SkillReadAllowed bool
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
	sort.Slice(candidates, func(i, j int) bool {
		if candidates[i].Priority != candidates[j].Priority {
			return candidates[i].Priority > candidates[j].Priority
		}
		return candidates[i].Value.Ref.AssetID < candidates[j].Value.Ref.AssetID
	})
	out := ResolvedSelection{Selection: Selection{Selected: []RevisionRef{}, Omitted: []OmittedAsset{}}, Assets: []AssetRevision{}}
	reasons := make([]string, len(candidates))
	groups := map[string]int{}
	for i, c := range candidates {
		reason := c.UnavailableReason
		if reason == "" && (!intersects(c.Value.Applicability.Profiles, []string{q.Profile}) || !intersects(c.Value.Applicability.ResourceKinds, q.ResourceKinds) || !intersects(c.Value.Applicability.DomainTags, q.DomainTags)) {
			reason = "not_applicable"
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
		if reason == "" && hashes[c.Value.Ref.ContentHash] {
			reason = "duplicate_content"
		}
		cost := AssetPromptCost(c.Value)
		if reason == "" && cost > maxBytes {
			reason = "asset_budget"
		}
		if reason != "" {
			out.Selection.Omitted = append(out.Selection.Omitted, OmittedAsset{c.Value.Ref, reason})
			continue
		}
		hashes[c.Value.Ref.ContentHash] = true
		maxBytes -= cost
		out.Assets = append(out.Assets, c.Value)
		out.Selection.Selected = append(out.Selection.Selected, c.Value.Ref)
	}
	return out
}

// AssetPromptCost includes JSON escaping, references and a conservative share
// of the fixed data envelope, rather than counting only raw body bytes.
func AssetPromptCost(value AssetRevision) int { raw, _ := json.Marshal(value); return len(raw)*2 + 512 }
