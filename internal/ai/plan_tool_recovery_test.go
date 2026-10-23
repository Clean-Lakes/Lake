package ai

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func responsesFixture(text string, calls ...Call) any {
	output := []any{}
	if text != "" {
		output = append(output, map[string]any{"type": "message", "role": "assistant", "content": []any{map[string]any{"type": "output_text", "text": text}}})
	}
	for _, call := range calls {
		output = append(output, map[string]any{"type": "function_call", "id": "fc_" + call.ID, "call_id": call.ID, "name": call.Name, "arguments": call.Arguments})
	}
	return map[string]any{"status": "completed", "output": output, "usage": map[string]any{"input_tokens": 10, "output_tokens": 4}}
}

func TestPlanModeRecoversMalformedQuestionWithoutReplayingInvestigation(t *testing.T) {
	var requests atomic.Int32
	var e *Engine
	m, close := fakeModel(t, func(n int, body map[string]any) any {
		requests.Add(1)
		if !strings.Contains(str(body["instructions"]), "PLAN MODE") {
			t.Error("planning constraints lost")
		}
		for _, tool := range arr(body["tools"]) {
			if !planToolAllowed(str(obj(tool)["name"])) {
				t.Error("unsafe tool exposed")
			}
		}
		switch n {
		case 1:
			return responsesFixture("只读查看现有资源。", Call{ID: "observed", Name: "list_assets", Arguments: `{}`})
		case 2:
			return responsesFixture("有一个范围需要确认。", Call{ID: "broken-question", Name: "ask_user_question", Arguments: `{"questions":[`})
		case 3:
			if !strings.Contains(str(body["instructions"]), toolCallRecoveryNotice) || !strings.Contains(js(body["input"]), "observed") {
				t.Error("recovery lost context or format guidance")
			}
			manifest := readPromptManifest(t, e, "case")
			if manifest.RetryOf == "" || !hasPromptSource(manifest, "tool-call-recovery") || !hasPromptSource(manifest, "plan-mode") {
				t.Error("recovery request did not retain auditable planning rules")
			}
			return responsesFixture("请确认检查范围。", Call{ID: "scope-question", Name: "ask_user_question", Arguments: `{"questions":[{"id":"scope","title":"完整性检查范围","options":["全部数据库","指定数据库"]}]}`})
		default:
			if !strings.Contains(js(body["input"]), "全部数据库") {
				t.Error("plan was produced without the user's answer")
			}
			return responsesFixture("<proposed_plan>\n# 数据迁移完整性检查计划\n\n1. 比较全部数据库的对象与行数。\n2. 确认后执行完整性抽查。\n3. 记录差异并验证。\n</proposed_plan>")
		}
	})
	defer close()
	m.Protocol = "openai-response"
	e = engineFor(t, m, nil)
	s, _ := e.get("case")
	s.mu.Lock()
	c := s.state.Config
	s.mu.Unlock()
	c.ConversationMode = ModePlan
	if err := e.Configure("case", c); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- e.Chat(ctx, "case", "帮我制定数据库迁移完整性检查计划。", nil) }()
	var question *QuestionRequest
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); {
		view, err := e.Snapshot("case")
		if err != nil {
			t.Fatal(err)
		}
		if view.Question != nil {
			question = view.Question
			if view.ProposedPlan != nil {
				t.Fatal("unanswered choice became executable plan")
			}
			break
		}
		if view.Status == "failed" {
			t.Fatal("format error was not recovered")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if question == nil {
		t.Fatal("clarification UI never became available")
	}
	if err := e.ReplyQuestion("case", question.ID, map[string][]string{"scope": {"全部数据库"}}); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	view, _ := e.Snapshot("case")
	plans, err := e.ProposedPlans("case")
	if err != nil || view.Status != "completed" || view.ProposedPlan == nil || len(plans) != 1 || requests.Load() != 4 {
		t.Fatal("planning did not finish after clarification", err, requests.Load())
	}
	if view.Usage.Total != 56 {
		t.Fatal("failed response usage lost during recovery", view.Usage.Total)
	}
	history, err := e.History("case")
	if err != nil {
		t.Fatal(err)
	}
	observed, questions := 0, 0
	for _, message := range history {
		for _, call := range message.Calls {
			switch call.ID {
			case "observed":
				observed++
			case "scope-question":
				questions++
			case "broken-question":
				t.Fatal("rejected call persisted as executable history")
			}
		}
	}
	if observed != 1 || questions != 1 {
		t.Fatal("completed investigation or question was replayed")
	}
}

func TestPlanModeInvalidToolRecoveryIsBounded(t *testing.T) {
	var attempts atomic.Int32
	m, close := fakeModel(t, func(n int, body map[string]any) any {
		attempts.Add(1)
		return responsesFixture("", Call{ID: "bad", Name: "ask_user_question", Arguments: `{"questions":[`})
	})
	defer close()
	m.Protocol = "openai-response"
	e := engineFor(t, m, nil)
	s, _ := e.get("case")
	s.mu.Lock()
	c := s.state.Config
	s.mu.Unlock()
	c.ConversationMode = ModePlan
	if err := e.Configure("case", c); err != nil {
		t.Fatal(err)
	}
	err := e.Chat(context.Background(), "case", "制定计划", nil)
	if !errors.Is(err, ErrInvalidModelToolCall) || attempts.Load() != 2 {
		t.Fatal("invalid calls were retried without a bound", attempts.Load(), err)
	}
	view, _ := e.Snapshot("case")
	plans, _ := e.ProposedPlans("case")
	if view.ProposedPlan != nil || view.Question != nil || len(plans) != 0 {
		t.Fatal("failed generation created an executable proposal or question")
	}
}
