package ai

import (
	"context"
	"strings"
	"testing"
)

func TestConversationStyleAppliesAcrossProfilesAndSchemas(t *testing.T) {
	configs := []Config{{}, {Profile: "terminal2"}, {Profile: "db-query-editor"}, {sreCoordinator: true}, {workflowMode: true}, {agentRole: "investigator"}}
	for _, c := range configs {
		prompt := Prompt(c)
		for _, part := range []string{"Default conversation style:", "not a multi-section report", "Brevity must never imply success", "explicit request for a detailed report", "Preserve required machine-readable JSON schemas"} {
			if !strings.Contains(prompt, part) {
				t.Errorf("profile %q role %q missing %q", c.Profile, c.agentRole, part)
			}
		}
	}
	summary := sreOutputInstruction(SREPlanStep{Kind: "summarize"})
	if !strings.Contains(summary, "one or two short conversational paragraphs") || strings.Contains(summary, "3..5 short points") {
		t.Fatal("SRE summary still mandates a report template")
	}
	if !strings.Contains(sreOutputInstruction(SREPlanStep{Kind: "observe"}), "NODE CHECKPOINT") {
		t.Fatal("node checkpoint cadence changed")
	}
}

func TestConversationStyleRefreshesWithHistoryAndPreservesDetailedRequest(t *testing.T) {
	calls := 0
	model, closeModel := fakeModel(t, func(_ int, body map[string]any) any {
		calls++
		messages := arr(body["messages"])
		policy := str(obj(messages[0])["content"])
		if !strings.Contains(policy, "Default conversation style:") {
			t.Error("conversation style absent from actual model request")
		}
		if calls == 2 {
			if !strings.Contains(js(messages), "请提供详细报告和完整表格") {
				t.Error("explicit detailed request was removed")
			}
			if !strings.Contains(js(messages), "已有报告原文") {
				t.Error("prior reply was removed to enforce brevity")
			}
		}
		return response("已有报告原文")
	})
	defer closeModel()
	e := engineFor(t, model, nil)
	if err := e.Configure("style", Config{Model: model, Profile: "core", Runtime: "local"}); err != nil {
		t.Fatal(err)
	}
	if err := e.Chat(context.Background(), "style", "仅解释给定的测试数据，不执行操作", nil); err != nil {
		t.Fatal(err)
	}
	if err := e.Chat(context.Background(), "style", "请提供详细报告和完整表格", nil); err != nil {
		t.Fatal(err)
	}
	if calls != 2 {
		t.Fatalf("unexpected calls %d", calls)
	}
}
