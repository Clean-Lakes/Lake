package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestPlanModeToolsAndPermissionsFailClosed(t *testing.T) {
	p := Permissions{SilentReadFiles: true, SilentWriteFiles: true, SilentReadSQL: true, SilentCommands: true, SilentTerminalCreation: true}
	c := Config{ConversationMode: ModePlan, Permissions: &p}
	for _, name := range []string{"write", "edit", "multi_edit", "append", "delete", "stage_attachment", "import_resources", "call_mcp_tool", "list_mcp_tools", "save_project_memory", "forget_project_memory", "run_workflow", "save_workflow", "schedule_create", "schedule_update", "schedule_delete", "task_stop", "terminal_send_input", "ssh_terminal_send", "open_ssh_tunnel", "delegate_investigation", "future_write_tool"} {
		if err := checkPlanOperation(c, name, "readonly"); err == nil {
			t.Errorf("Plan accepted %s before dispatch", name)
		}
	}
	for _, name := range []string{"shell", "terminal_execute_command", "execute_sql", "redis_command", "open_ssh_terminal"} {
		for _, risk := range []string{"write", "dangerous", ""} {
			if _, err := approvalKind(c, name, risk, nil); err == nil {
				t.Errorf("Plan accepted %s risk=%q with silent permissions", name, risk)
			}
		}
	}
	for _, name := range []string{"read", "ls", "glob", "grep", "list_assets", "execute_sql", "redis_command", "shell", "inspect_attachment"} {
		if kind, err := approvalKind(c, name, "readonly", nil); err != nil || kind != "" {
			t.Errorf("readonly %s rejected: %s %v", name, kind, err)
		}
	}
	if _, err := approvalKind(Config{Permissions: &p}, "write", "write", nil); err != nil {
		t.Fatalf("ordinary execution changed: %v", err)
	}
}

func TestPlanModeEnforcesDenialsAndPersistsProposal(t *testing.T) {
	workspace := t.TempDir()
	target := filepath.Join(workspace, "should-not-exist")
	var denied atomic.Bool
	m, close := fakeModel(t, func(step int, body map[string]any) any {
		if !strings.Contains(str(obj(body["messages"].([]any)[0])["content"]), "PLAN MODE") {
			t.Error("planning instructions missing")
		}
		for _, tool := range body["tools"].([]any) {
			if !planToolAllowed(str(obj(obj(tool)["function"])["name"])) {
				t.Error("unsafe tool advertised")
			}
		}
		if step == 1 {
			return response("先调查", Call{ID: "blocked-write", Name: "write", Arguments: js(map[string]any{"path": target, "content": "unsafe"})})
		}
		for _, item := range body["messages"].([]any) {
			message := obj(item)
			if message["role"] == "tool" && (strings.Contains(str(message["content"]), "Plan") || strings.Contains(str(message["content"]), "unavailable")) {
				denied.Store(true)
			}
		}
		return response("<proposed_plan>\n# 实施方案\n\n1. 调整配置。\n2. 验证结果。\n</proposed_plan>")
	})
	defer close()
	e := engineFor(t, m, nil)
	s, _ := e.get("case")
	s.mu.Lock()
	c := s.state.Config
	s.mu.Unlock()
	c.ConversationMode = ModePlan
	c.StrategyCorrectEnabled = true
	c.StrategyLearnEnabled = true
	c.Permissions = &Permissions{SilentReadFiles: true, SilentWriteFiles: true, SilentCommands: true}
	if err := e.Configure("case", c); err != nil {
		t.Fatal(err)
	}
	if err := e.ExecuteTurn(context.Background(), "case", TurnInput{UserText: "实现这个变更", SRECoordination: true}); err != nil {
		t.Fatal(err)
	}
	if !denied.Load() {
		t.Fatal("model did not receive a paired denial")
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatal("Plan mode wrote a file")
	}
	view, _ := e.Snapshot("case")
	if view.ProposedPlan == nil || !strings.Contains(view.ProposedPlan.Content, "实施方案") {
		t.Fatalf("proposal missing: %+v", view.ProposedPlan)
	}
	// A fresh engine reads persisted UI state rather than relying on memory.
	reloaded, err := New(e.Dir, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer reloaded.Shutdown()
	restored, err := reloaded.Snapshot("case")
	if err != nil || restored.ProposedPlan == nil || restored.ProposedPlan.ID != view.ProposedPlan.ID {
		t.Fatal("proposal not persisted", err)
	}
	plans, err := reloaded.ProposedPlans("case")
	if err != nil || len(plans) != 1 || plans[0].ID != view.ProposedPlan.ID || strings.Contains(plans[0].Content, "<proposed_plan>") {
		t.Fatal("plan list did not survive restart", err)
	}
	if err := e.ExecuteTurn(context.Background(), "case", TurnInput{UserText: "调整计划", workflow: []WorkflowStep{{}}}); err == nil {
		t.Fatal("Plan accepted workflow execution")
	}
}

func TestPlanModeHistorySurvivesRevisionsExecutionAndCardPagination(t *testing.T) {
	e := engineFor(t, Model{URL: "http://127.0.0.1:1/v1/chat/completions", Name: "fixture", Protocol: "openai"}, nil)
	s, _ := e.get("case")
	s.mu.Lock()
	s.state.View.Cards = []Card{{ID: "first", Type: "message", Content: "<proposed_plan>\n# First\n</proposed_plan>", At: timestamp()}}
	// Compatibility: the previous Dev stored the current proposal without a marker.
	s.state.View.ProposedPlan = &ProposedPlan{ID: "first", Content: "# First", At: timestamp()}
	archiveProposedPlan(s)
	s.state.View.ProposedPlan = nil
	for i := 0; i < 320; i++ {
		s.state.View.Cards = append(s.state.View.Cards, Card{ID: uid(), Type: "message", Content: "ordinary answer"})
	}
	firstCard := len(s.state.View.Cards)
	s.state.View.Cards = append(s.state.View.Cards, Card{ID: "revised", Type: "message", Content: "<proposed_plan>\n# Revised\n</proposed_plan>", At: timestamp()})
	captureProposedPlan(s, firstCard)
	// Executing/starting another turn consumes only the executable pointer.
	s.state.View.ProposedPlan = nil
	s.state.View.Cards = append(s.state.View.Cards, Card{ID: "unaccepted", Type: "message", Content: "<proposed_plan>\n# Not a successful planning turn\n</proposed_plan>"})
	err := e.save(s)
	s.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	reloaded, err := New(e.Dir, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer reloaded.Shutdown()
	view, err := reloaded.Snapshot("case")
	if err != nil || view.CardsOffset == 0 {
		t.Fatal("fixture does not exercise pagination", err)
	}
	plans, err := reloaded.ProposedPlans("case")
	if err != nil || len(plans) != 2 || plans[0].ID != "revised" || plans[1].ID != "first" {
		t.Fatalf("history lost or unaccepted prose listed: %+v, %v", plans, err)
	}
	other, err := reloaded.ProposedPlans("other")
	if err != nil || len(other) != 0 {
		t.Fatal("plans leaked to another session", err)
	}
}

func TestPlanModeCannotReachMutatingSessionOrMemoryBridge(t *testing.T) {
	m, close := fakeModel(t, func(int, map[string]any) any { return response("unused") })
	defer close()
	called := false
	e := engineFor(t, m, func(context.Context, string, string, map[string]any, bool) (any, error) {
		called = true
		return nil, nil
	})
	s, _ := e.get("case")
	for _, name := range []string{"call_mcp_tool", "run_workflow", "schedule_create", "save_project_memory", "stage_attachment", "delete"} {
		if _, err := e.invoke(context.Background(), s, Config{ConversationMode: ModePlan}, Call{Name: name, Arguments: `{}`}); err == nil {
			t.Errorf("%s was not rejected", name)
		}
	}
	if called {
		t.Fatal("mutating tool reached bridge")
	}
}

func TestCapturePlanDoesNotReuseProgressOrEarlierTurn(t *testing.T) {
	s := &session{}
	s.state.View.Cards = []Card{{ID: "old", Type: "message", Content: "old plan"}, {ID: "progress", Type: "message", Content: "investigating"}, {Type: "operation"}}
	captureProposedPlan(s, 1)
	if s.state.View.ProposedPlan != nil {
		t.Fatal("progress promoted to plan")
	}
	captureProposedPlan(s, 3)
	if s.state.View.ProposedPlan != nil {
		t.Fatal("earlier turn promoted to plan")
	}
	s.state.View.Cards = []Card{{ID: "answer", Type: "message", Content: "需要选择哪个环境？"}}
	captureProposedPlan(s, 0)
	if s.state.View.ProposedPlan != nil {
		t.Fatal("ordinary answer or clarification promoted to executable plan")
	}
}

func TestPlanModeCapturesOnlyExplicitBlockWithSurroundingProse(t *testing.T) {
	const body = "# 完整性检查计划\n\n1. 核对对象。\n2. 确认后抽查数据。"
	block := "<proposed_plan>\n" + body + "\n</proposed_plan>"
	for _, text := range []string{block, "已确认范围：全部数据库。\n\n" + block, "说明\n" + block + "\n请审阅后执行。"} {
		content, ok := proposedPlanContent(text)
		if !ok || content != body {
			t.Fatal("intro or outro hid a complete plan")
		}
		s := &session{}
		s.state.View.Cards = []Card{{ID: "proposal", Type: "message", Content: text}}
		captureProposedPlan(s, 0)
		if s.state.View.ProposedPlan == nil || s.state.View.ProposedPlan.Content != body {
			t.Fatal("non-plan prose entered executable content")
		}
	}
	for _, text := range []string{"这是建议，并非完整计划。", "<proposed_plan>\n未完成", block + "\n" + block, "```xml\n" + block + "\n```", "> <proposed_plan>\nquoted\n> </proposed_plan>", "<proposed_plan>\n<proposed_plan>\nnested\n</proposed_plan>\n</proposed_plan>"} {
		if _, ok := proposedPlanContent(text); ok {
			t.Fatal("ambiguous, unfinished or example text became executable")
		}
	}
	withCode := "<proposed_plan>\n# 验证\n\n```sql\nSELECT 1;\n```\n</proposed_plan>"
	if content, ok := proposedPlanContent(withCode); !ok || !strings.Contains(content, "SELECT 1;") {
		t.Fatal("plan code fence was lost")
	}
}

func TestPlanModeLegacyPlanRemainsReviewableWithoutBecomingExecutable(t *testing.T) {
	e := engineFor(t, Model{URL: "http://127.0.0.1:1/v1/chat/completions", Name: "fixture"}, nil)
	s, _ := e.get("case")
	s.mu.Lock()
	s.state.View.Cards = []Card{{ID: "legacy", Type: "message", Status: "completed", Content: "已确认范围。\n<proposed_plan>\n# 旧计划\n\n1. 核对。\n</proposed_plan>"}, {ID: "failed", Type: "message", Status: "failed", Content: "<proposed_plan>\n未完成\n</proposed_plan>"}}
	s.mu.Unlock()
	plans, err := e.ProposedPlans("case")
	if err != nil || len(plans) != 1 || plans[0].ID != "legacy" || plans[0].Content != "# 旧计划\n\n1. 核对。" {
		t.Fatal("legacy plan lost when chat body is hidden", err)
	}
	view, err := e.Snapshot("case")
	if err != nil || view.ProposedPlan != nil {
		t.Fatal("reviewing legacy plan granted execution authority", err)
	}
}

func TestPlanModeRequiresTrustedReadonlyCommandPolicy(t *testing.T) {
	m, close := fakeModel(t, func(int, map[string]any) any { return response("unused") })
	defer close()
	executions := 0
	e := engineFor(t, m, func(_ context.Context, _ string, name string, a map[string]any, _ bool) (any, error) {
		if name == "policy" {
			risk := "write"
			if str(obj(a["arguments"])["command"]) == "pwd" {
				risk = "readonly"
			}
			return map[string]any{"risk": risk, "fingerprint": "fixture", "runtime": "local"}, nil
		}
		if name == "runtimeCommandExec" {
			executions++
			return map[string]any{"output": "/fixture", "exit_code": 0}, nil
		}
		return map[string]any{}, nil
	})
	s, _ := e.get("case")
	s.mu.Lock()
	c := s.state.Config
	s.mu.Unlock()
	c.ConversationMode = ModePlan
	c.Permissions = &Permissions{SilentCommands: true, SilentTerminalCreation: true}
	for _, command := range []string{"touch /tmp/should-not-exist", "arbitrary-unknown-command"} {
		if _, err := e.invoke(context.Background(), s, c, Call{ID: uid(), Name: "shell", Arguments: js(map[string]any{"command": command})}); err == nil {
			t.Errorf("Plan accepted command %s", command)
		}
	}
	if _, err := e.invoke(context.Background(), s, c, Call{ID: uid(), Name: "shell", Arguments: `{"command":"pwd"}`}); err != nil {
		t.Fatal("trusted readonly command failed", err)
	}
	if executions != 1 {
		t.Fatalf("want only readonly execution, got %d", executions)
	}
}

func TestPlanModeQuestionRecoveryPreservesReadonlyAndProposal(t *testing.T) {
	home := t.TempDir()
	model, close := fakeModel(t, func(n int, input map[string]any) any {
		if n == 1 {
			return response("", Call{ID: "durable-question", Name: "ask_user_question", Arguments: js(map[string]any{"questions": []any{map[string]any{"id": "target", "title": "Choose the fixture target", "options": []any{map[string]any{"label": "test only"}}}}})})
		}
		if !strings.Contains(js(input["messages"]), "test only") {
			t.Error("human answer missing from resumed provider request")
		}
		return response("<proposed_plan>\n# Recovered plan\n\n1. Inspect.\n2. Apply after review.\n3. Verify.\n</proposed_plan>")
	})
	defer close()
	binary, _ := os.Executable()
	child := exec.Command(binary, "-test.run=^TestADKCrashApprovalHelper$", "-test.timeout=60s")
	var childOutput bytes.Buffer
	child.Stdout, child.Stderr = &childOutput, &childOutput
	child.Env = append(os.Environ(), "LAKE_ADK_CRASH_HELPER=1", "LAKE_ADK_CRASH_MODE=plan", "LAKE_ADK_CRASH_HOME="+home, "LAKE_ADK_CRASH_PROVIDER="+model.URL)
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = child.Process.Kill(); _ = child.Wait() }()
	var state State
	ready := false
	for deadline := time.Now().Add(30 * time.Second); time.Now().Before(deadline); {
		raw, _ := os.ReadFile(filepath.Join(home, "case.json"))
		_ = json.Unmarshal(raw, &state)
		if nativeQuestionReady(state.View.Question) && state.Runtime != nil {
			ready = true
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !ready {
		_ = child.Process.Kill()
		_ = child.Wait()
		t.Fatalf("no durable official workflow question: %s", childOutput.String())
	}
	_ = child.Process.Kill()
	_ = child.Wait()
	e, err := New(home, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Shutdown()
	if err = e.Configure("case", Config{ConversationMode: ModePlan, Model: model, Profile: "core", Workspace: home}); err != nil {
		t.Fatal(err)
	}
	if err = e.ReplyQuestion("case", state.View.Question.ID, map[string][]string{"target": {"test only"}}); err != nil {
		t.Fatal(err)
	}
	for deadline := time.Now().Add(15 * time.Second); ; {
		view, _ := e.Snapshot("case")
		if view.Status == "completed" {
			if view.ProposedPlan == nil || !strings.Contains(view.ProposedPlan.Content, "Recovered plan") {
				t.Fatal("recovered planning turn lost its proposal")
			}
			break
		}
		if view.Status == "failed" || time.Now().After(deadline) {
			t.Fatalf("question did not resume: %s %v", view.Status, view.Cards)
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err = e.ReplyQuestion("case", state.View.Question.ID, map[string][]string{"target": {"test only"}}); err == nil {
		t.Fatal("question reply replay accepted")
	}
}
