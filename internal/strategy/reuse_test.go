package strategy

import (
	"encoding/json"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestReuseKeywordRankingCountBudgetAndHonestReasons(t *testing.T) {
	candidates := []Candidate{}
	for _, id := range []string{"z", "a", "b", "c", "irrelevant"} {
		c := candidate(id, "Method "+id, 1, "")
		c.Reuse = ReusePolicy{Keywords: []string{"日志"}}
		if id == "z" {
			c.Reuse.Keywords = append(c.Reuse.Keywords, "磁盘")
		}
		if id == "irrelevant" {
			c.Reuse.Keywords = []string{"postgres"}
			c.Priority = 1000
		}
		candidates = append(candidates, c)
	}
	got := Resolve(candidates, SelectionQuery{Profile: "core", TaskText: "检查磁盘和日志"}, 100000)
	if len(got.Assets) != 3 || got.Assets[0].Ref.AssetID != "z" || got.Selection.Reasons[0].Score != 2 {
		t.Fatal("ranking/count not bounded", got)
	}
	reasons := map[string]string{}
	for _, o := range got.Selection.Omitted {
		reasons[o.Ref.AssetID] = o.Reason
	}
	if reasons["irrelevant"] != "not_relevant" || reasons["c"] != "asset_count" {
		t.Fatal(reasons)
	}
	cost := 0
	for _, a := range got.Assets {
		cost += AssetPromptCost(a)
	}
	if cost > MaxAssetPromptBytes {
		t.Fatal("budget exceeded")
	}
	huge := candidate("huge", strings.Repeat("中", 1600), 0, "")
	huge.Reuse = ReusePolicy{General: true}
	result := Resolve([]Candidate{huge}, SelectionQuery{TaskText: "报告"}, 100000)
	if len(result.Assets) != 0 || result.Selection.Omitted[0].Reason != "asset_budget" {
		t.Fatal("UTF8 envelope overflow")
	}
	short := candidate("short", "Quote \"<&>\"\n中文", 0, "")
	raw, _ := json.Marshal(short.Value)
	if AssetPromptCost(short.Value) < len(raw) {
		t.Fatal("JSON escaping ignored")
	}
}
func TestReuseRelevanceConflictAndValidation(t *testing.T) {
	p := ReusePolicy{Keywords: []string{"db", "磁盘"}}
	if score, _ := p.Relevance("debug unrelated"); score != 0 {
		t.Fatal("substring invented english relevance")
	}
	if score, _ := p.Relevance("DB failure and 磁盘"); score != 2 {
		t.Fatal("case/Chinese matching failed")
	}
	if _, reason := p.Relevance("介绍一首诗"); reason != "not_relevant" {
		t.Fatal("unrelated matched")
	}
	a, b := candidate("a", "a", 0, "same"), candidate("b", "b", 100, "same")
	a.Reuse, b.Reuse = p, p
	got := Resolve([]Candidate{a, b}, SelectionQuery{TaskText: "db error"}, 4096)
	if len(got.Assets) != 0 || got.Selection.Omitted[0].Reason != "exclusion_conflict" {
		t.Fatal("conflict selected winner")
	}
	for _, bad := range []ReusePolicy{{General: true}, {Keywords: []string{"a"}}, {Keywords: []string{"db", "DB"}}, {ValidUntil: "yesterday"}} {
		if bad.Validate(DomainProcedure) == nil {
			t.Fatal("invalid policy accepted", bad)
		}
	}
}

func TestReuseBoundedChineseTaskAndNormalizedDuplicate(t *testing.T) {
	bounded := BoundedTask(strings.Repeat("磁盘", 3000))
	if len(bounded) > 8192 || !utf8.ValidString(bounded) {
		t.Fatal("invalid bounded task")
	}
	a, b := candidate("a", "Rule\n中文", 1, ""), candidate("b", " Rule\r\n中文 ", 0, "")
	a.Reuse, b.Reuse = ReusePolicy{General: true}, ReusePolicy{General: true}
	result := Resolve([]Candidate{a, b}, SelectionQuery{TaskText: "任务"}, 4096)
	if len(result.Assets) != 1 || result.Selection.Omitted[0].Reason != "duplicate_content" {
		t.Fatal("line-ending duplicate injected")
	}
}
