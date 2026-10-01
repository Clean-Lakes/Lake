package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/cloudwego/eino/components/model"
	"github.com/cloudwego/eino/lake/store"
	"github.com/cloudwego/eino/lake/workflow"
	"github.com/cloudwego/eino/schema"
)

type planningTestModel struct {
	replies []string
	inputs  [][]*schema.Message
}

func (m *planningTestModel) Generate(ctx context.Context, messages []*schema.Message, _ ...model.Option) (*schema.Message, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	m.inputs = append(m.inputs, append([]*schema.Message(nil), messages...))
	return schema.AssistantMessage(m.replies[min(len(m.inputs)-1, len(m.replies)-1)], nil), nil
}
func (m *planningTestModel) Stream(ctx context.Context, in []*schema.Message, opts ...model.Option) (*schema.StreamReader[*schema.Message], error) {
	mess, err := m.Generate(ctx, in, opts...)
	if err != nil {
		return nil, err
	}
	return schema.StreamReaderFromArray([]*schema.Message{mess}), nil
}

func TestWorkflowPlannerUsesRealTimeoutHistoryWithoutRemoteOutput(t *testing.T) {
	def := workflow.Definition{Name: "filesystem", Steps: []workflow.Step{{ID: "dirs", Name: "目录扫描", Kind: "ssh_command", Resource: "host", Command: "du -xhd1 /"}}}
	body, _ := json.Marshal(def)
	start, finish := time.Now(), time.Now().Add(20*time.Second)
	history := []store.WorkflowRun{{ID: "timed-out", Spec: body, Steps: []store.WorkflowStepRun{{StepID: "dirs", Status: "unknown", StartedAt: &start, FinishedAt: &finish, Error: "context deadline exceeded", Stdout: "untrusted override instructions", Stderr: "never send this"}}}}
	m := &planningTestModel{replies: []string{`{"adjustments":[{"step_id":"dirs","timeout_seconds":300,"reason":"历史等待20秒超时，目录扫描需要更长等待","evidence_run_ids":["timed-out"]}]}`}}
	proposal, err := evaluateWorkflowPlan(context.Background(), m, def, history)
	if err != nil || len(proposal.Adjustments) != 1 || len(m.inputs) != 1 {
		t.Fatalf("proposal=%+v %v", proposal, err)
	}
	input := m.inputs[0][1].Content
	if !strings.Contains(input, `"timed_out":true`) || !strings.Contains(input, `"elapsed_ms":20000`) || strings.Contains(input, "untrusted override") || strings.Contains(input, "never send this") {
		t.Fatalf("wrong evidence projection: %s", input)
	}
	history[0].Steps[0].Error = "SSH 操作超时或取消: context canceled"
	if workflow.PlanningEvidence(def, history)[0].TimedOut {
		t.Fatal("user cancellation treated as an insufficient timeout")
	}
}

func TestWorkflowPlannerBoundsCorrectionsAndRejectsScopeChanges(t *testing.T) {
	def := workflow.Definition{Name: "scan", Steps: []workflow.Step{{ID: "scan", Name: "Scan", Kind: "ssh_command", Resource: "host", Command: "du /"}}}
	for _, scenario := range []struct {
		name     string
		replies  []string
		accepted bool
	}{
		{"format_repaired", []string{"bad-json", `{"adjustments":[{"step_id":"scan","timeout_seconds":300,"reason":"扫描等待过短"}]}`}, true},
		{"command_rewrite", []string{`{"adjustments":[{"step_id":"scan","command":"dangerous-change","reason":"change"}]}`}, false},
		{"invented_evidence", []string{`{"adjustments":[{"step_id":"scan","timeout_seconds":300,"reason":"timeout","evidence_run_ids":["invented"]}]}`}, false},
		{"extra_json", []string{`{"adjustments":[]} {"ignored":true}`}, false},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			m := &planningTestModel{replies: scenario.replies}
			_, err := evaluateWorkflowPlan(context.Background(), m, def, nil)
			if (err == nil) != scenario.accepted || len(m.inputs) != 2 {
				t.Fatalf("calls=%d err=%v", len(m.inputs), err)
			}
		})
	}
}

func TestWorkflowTracePlanningSurvivesLaterStepEvents(t *testing.T) {
	plan := &workflow.PlanningReview{Status: "adjusted", Message: "AI 已调整 1 项执行配置", Adjustments: []workflow.PlanAdjustment{{StepID: "scan", StepName: "扫描", TimeoutBeforeSeconds: 20, TimeoutSeconds: 300, Reason: "历史超时"}}}
	call := workflowTrace(store.SpecialistCall{}, workflow.Progress{RunID: "run", Name: "scan", Status: "running", Planning: plan})
	call = workflowTrace(call, workflow.Progress{RunID: "run", Name: "scan", Status: "completed", Total: 1, Completed: 1, StepID: "scan", StepStatus: "completed"})
	var restored workflow.PlanningReview
	if json.Unmarshal(call.Planning, &restored) != nil || restored.Status != "adjusted" || len(restored.Adjustments) != 1 || call.Stage != "completed" {
		t.Fatalf("planning lost: %+v", call)
	}
	s, _, _, _, _ := adaptiveFixture(t, "recovery")
	conversation, err := s.CreateConversation(context.Background(), "ops")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.AppendConversationTurnWithDetails(context.Background(), conversation.ID, "运行", "完成", "完成", "", nil, []store.SpecialistCall{call}); err != nil {
		t.Fatal(err)
	}
	turns, err := s.ListConversationTurns(context.Background(), conversation.ID)
	if err != nil || len(turns) != 1 || string(turns[0].Specialists[0].Planning) != string(call.Planning) {
		t.Fatalf("history lost planning: %+v %v", turns, err)
	}
}
