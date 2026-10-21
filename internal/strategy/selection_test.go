package strategy

import "testing"

func candidate(id, body string, priority int, group string) Candidate {
	return Candidate{Value: AssetRevision{Ref: RevisionRef{id, 1, ContentHash(body)}, Body: body}, Priority: priority, ExclusionGroup: group}
}
func TestResolveStrategySelection(t *testing.T) {
	a := candidate("a", "first", 5, "")
	b := candidate("b", "second", 5, "")
	c := candidate("c", "first", 1, "")
	result := Resolve([]Candidate{c, b, a}, SelectionQuery{Profile: "core"}, 10000)
	if len(result.Assets) != 2 || result.Assets[0].Ref.AssetID != "a" || result.Assets[1].Ref.AssetID != "b" || result.Selection.Omitted[0].Reason != "duplicate_content" {
		t.Fatal(result)
	}
	a.ExclusionGroup = "conflict"
	b.ExclusionGroup = "conflict"
	result = Resolve([]Candidate{a, b}, SelectionQuery{Profile: "core"}, 10000)
	if len(result.Assets) != 0 || len(result.Selection.Omitted) != 2 || result.Selection.Omitted[0].Reason != "exclusion_conflict" {
		t.Fatal(result)
	}
	b.Value.Applicability.Profiles = []string{"terminal2"}
	result = Resolve([]Candidate{a, b}, SelectionQuery{Profile: "core"}, 10000)
	if len(result.Assets) != 1 || result.Selection.Omitted[0].Reason != "not_applicable" {
		t.Fatal(result)
	}
	a.Value.Applicability.DomainTags = []string{"database"}
	result = Resolve([]Candidate{a}, SelectionQuery{Profile: "core"}, 10000)
	if len(result.Assets) != 0 || result.Selection.Omitted[0].Reason != "not_applicable" {
		t.Fatal(result)
	}
	result = Resolve([]Candidate{c}, SelectionQuery{Profile: "core"}, 1)
	if result.Selection.Omitted[0].Reason != "asset_budget" {
		t.Fatal(result)
	}
}
