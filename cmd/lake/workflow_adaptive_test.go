package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cloudwego/eino/components/model"
	"github.com/cloudwego/eino/lake/operate"
	"github.com/cloudwego/eino/lake/store"
	sshtransport "github.com/cloudwego/eino/lake/transport/ssh"
	"github.com/cloudwego/eino/lake/workflow"
	"github.com/cloudwego/eino/schema"
)

type adaptiveTestModel struct {
	calls    int
	scenario string
}

func (m *adaptiveTestModel) WithTools([]*schema.ToolInfo) (model.ToolCallingChatModel, error) {
	return m, nil
}
func (m *adaptiveTestModel) Generate(_ context.Context, in []*schema.Message, _ ...model.Option) (*schema.Message, error) {
	if len(in) > 0 && in[0].Content == workflowPlanningInstruction {
		return schema.AssistantMessage(`{"adjustments":[]}`, nil), nil
	}
	m.calls++
	if m.scenario == "no_verification" {
		if m.calls == 1 {
			return schema.AssistantMessage("", []schema.ToolCall{{ID: "complete", Type: "function", Function: schema.FunctionCall{Name: "lake_workflow_recovery_complete", Arguments: `{"success":true,"summary":"claimed success","evidence_call_id":"invented"}`}}}), nil
		}
		return schema.AssistantMessage("done", nil), nil
	}
	commands := []string{"inspect-service", "alternate-restart", "service-health"}
	if m.calls <= 3 {
		resource := "host"
		if m.scenario == "outside" {
			resource = "other"
		}
		args, _ := json.Marshal(workflowRecoveryInput{Resource: resource, Command: commands[m.calls-1], Verify: m.calls == 3})
		ids := []string{"inspect", "restart", "verified"}
		return schema.AssistantMessage("", []schema.ToolCall{{ID: ids[m.calls-1], Type: "function", Function: schema.FunctionCall{Name: "lake_ssh", Arguments: string(args)}}}), nil
	}
	if m.calls == 4 {
		return schema.AssistantMessage("", []schema.ToolCall{{ID: "complete", Type: "function", Function: schema.FunctionCall{Name: "lake_workflow_recovery_complete", Arguments: `{"success":true,"summary":"manual process restarted and health verified","evidence_call_id":"verified"}`}}}), nil
	}
	return schema.AssistantMessage("done", nil), nil
}
func (m *adaptiveTestModel) Stream(ctx context.Context, in []*schema.Message, opts ...model.Option) (*schema.StreamReader[*schema.Message], error) {
	v, e := m.Generate(ctx, in, opts...)
	if e != nil {
		return nil, e
	}
	return schema.StreamReaderFromArray([]*schema.Message{v}), nil
}

type adaptiveTestSSH struct {
	commands        []string
	unknown         bool
	unknownRecovery bool
}

func (r *adaptiveTestSSH) Run(_ context.Context, _ sshtransport.Target, _ []byte, command string) (sshtransport.Result, error) {
	r.commands = append(r.commands, command)
	if r.unknownRecovery && command == "inspect-service" {
		return sshtransport.Result{}, errors.New("lost recovery exec response")
	}
	if command == "original-restart" {
		if r.unknown {
			return sshtransport.Result{}, errors.New("lost exec response")
		}
		return sshtransport.Result{ExitCode: 3, Stderr: "unit not found; service is a manual process"}, nil
	}
	return sshtransport.Result{Stdout: command + ": active", ExitCode: 0}, nil
}

func adaptiveFixture(t *testing.T, scenario string) (*store.Store, store.WorkflowDefinition, *workflowAdaptiveExecutor, *adaptiveTestModel, *adaptiveTestSSH) {
	t.Helper()
	ctx := context.Background()
	s, err := store.Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	lake, err := s.CreateLake(ctx, "ops", "")
	if err != nil {
		t.Fatal(err)
	}
	host, err := s.CreateHost(ctx, store.ResourceInput{LakeID: lake.ID, Name: "host", SSH: store.SSHSpec{Host: "example.invalid", Port: 22, Username: "root"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.SetExecuteAuthz(ctx, host.ID, true); err != nil {
		t.Fatal(err)
	}
	if _, err = s.SetCredentialRef(ctx, host.ID, "file:ssh/test"); err != nil {
		t.Fatal(err)
	}
	service, err := operate.NewServiceForLake(ctx, s, lake.Name)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { service.CloseSessions() })
	remote, m := &adaptiveTestSSH{}, &adaptiveTestModel{scenario: scenario}
	service.Runner, service.Keys = remote, &scriptTestKeys{}
	service.Confirm = func(context.Context, string, string) (bool, error) { return true, nil }
	def := workflow.Definition{Name: "restart", Description: "恢复host上的测试服务并确认健康，禁止改其他服务", Steps: []workflow.Step{{ID: "restart", Name: "恢复测试服务", Goal: "根据实际启动方式恢复并检查服务健康", Kind: "ssh_command", Resource: "host", Command: "original-restart"}, {ID: "after", Name: "后续节点", Kind: "ssh_command", Resource: "host", Command: "after", DependsOn: []string{"restart"}}}}
	if scenario == "fixed" {
		def.ExecutionMode = "fixed"
	}
	if scenario == "goal" {
		def.Steps[0].Kind = "ssh_task"
		def.Steps[0].Command = ""
	}
	if err := workflow.Validate(def); err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(def)
	saved, err := s.CreateWorkflow(ctx, lake.Name, def.Name, def.Description, body)
	if err != nil {
		t.Fatal(err)
	}
	runtime := &workflowV2Executor{store: s, service: service, model: m, modelID: "test", approve: func(string, string, string) (bool, error) {
		if scenario == "withdraw_during_approval" {
			_, err := s.SetExecuteAuthz(ctx, host.ID, false)
			return true, err
		}
		if scenario == "target_changed_during_approval" {
			db, err := sql.Open("sqlite", filepath.Join(s.Root(), "lake.db"))
			if err != nil {
				return false, err
			}
			defer db.Close()
			_, err = db.Exec(`UPDATE resource SET spec='{"ssh":{"host":"changed.invalid","port":22,"username":"root"}}' WHERE id=?`, host.ID)
			return true, err
		}
		return scenario != "denied", nil
	}}
	executor := &workflowAdaptiveExecutor{Service: service, runtime: runtime, definition: def}
	return s, saved, executor, m, remote
}

func TestWorkflowAdaptiveRecoveryVerifiesAlternativeThenContinuesDependency(t *testing.T) {
	for _, scenario := range []string{"recovery", "goal"} {
		t.Run(scenario, func(t *testing.T) {
			s, saved, e, m, remote := adaptiveFixture(t, scenario)
			run, err := workflow.Start(context.Background(), s, saved, "desktop", e, nil)
			if err != nil || run.Status != "completed" || m.calls != 5 {
				t.Fatalf("run=%+v calls=%d err=%v", run, m.calls, err)
			}
			if remote.commands[len(remote.commands)-1] != "after" || !strings.Contains(run.Steps[0].Stdout, `"evidence_call_id":"verified"`) || !strings.Contains(run.Steps[0].Stdout, `"verify":true`) {
				t.Fatalf("verification/dependency lost: %+v %v", run, remote.commands)
			}
			if scenario == "recovery" && strings.Count(strings.Join(remote.commands, ","), "original-restart") != 1 {
				t.Fatal("blind original retry")
			}
			if scenario == "recovery" && !strings.Contains(run.Steps[0].Stdout, "unit not found") {
				t.Fatal("initial failure evidence overwritten")
			}
			events, _ := s.ListWorkflowEvents(context.Background(), run.ID)
			if len(events) < 8 {
				t.Fatal("recovery progress missing")
			}
		})
	}
}

func TestWorkflowAdaptiveNoFalseSuccessOrApprovalScopeBypass(t *testing.T) {
	for _, scenario := range []string{"no_verification", "denied", "outside", "unknown", "fixed", "withdraw_during_approval", "target_changed_during_approval"} {
		t.Run(scenario, func(t *testing.T) {
			s, saved, e, m, remote := adaptiveFixture(t, scenario)
			remote.unknown = scenario == "unknown"
			run, err := workflow.Start(context.Background(), s, saved, "desktop", e, nil)
			if err != nil || run.Status != "failed" || run.Steps[1].Status != "skipped" {
				t.Fatalf("false completion: %+v %v", run, err)
			}
			if len(remote.commands) != 1 {
				t.Fatalf("unexpected remote effects: %v", remote.commands)
			}
			if (scenario == "fixed" || scenario == "unknown") && m.calls != 0 {
				t.Fatal("fixed/unknown started adaptive model")
			}
			if scenario == "unknown" && run.Steps[0].Status != "unknown" {
				t.Fatal("unknown write classified failed")
			}
			if scenario == "unknown" && run.Steps[0].ExitCode != nil {
				t.Fatal("unknown execution fabricated exit code")
			}
		})
	}
}

func TestWorkflowAdaptiveUnknownRecoveryCannotRunAnotherMethod(t *testing.T) {
	s, saved, e, _, remote := adaptiveFixture(t, "recovery")
	remote.unknownRecovery = true
	run, err := workflow.Start(context.Background(), s, saved, "desktop", e, nil)
	if err != nil || run.Status != "failed" || run.Steps[0].Status != "unknown" || run.Steps[0].ExitCode != nil || run.Steps[1].Status != "skipped" || strings.Join(remote.commands, ",") != "original-restart,inspect-service" {
		t.Fatalf("unknown recovery replayed: %+v %v %v", run, remote.commands, err)
	}
}

func TestWorkflowV2ResultContextFitsToolBudget(t *testing.T) {
	run := store.WorkflowV2Run{ID: "run", Name: "large", Status: "completed"}
	for i := 0; i < 32; i++ {
		body, _ := json.Marshal(strings.Repeat("\"\\\t", 6000))
		run.Nodes = append(run.Nodes, store.WorkflowV2Node{NodeID: "node", Status: "completed", Result: body})
	}
	body, err := json.Marshal(workflowV2ToolRun(run))
	if err != nil || !json.Valid(body) || len(body) > 60000 || !strings.Contains(string(body), `"truncated":true`) {
		t.Fatalf("result context invalid or too large: %d %v", len(body), err)
	}
}

func TestWorkflowAnalysisIncludesCompleteSmallOutputAndBoundsLargeRuns(t *testing.T) {
	output := strings.Repeat("port listener\n", 300) + "END_OF_PORTS"
	run := store.WorkflowRun{ID: "run", Name: "ports", Status: "completed", Steps: []store.WorkflowStepRun{{StepID: "ports", Status: "completed", Stdout: output}}}
	if summary := formatWorkflowRunAnswer(run); !strings.Contains(summary, "END_OF_PORTS") || strings.Contains(summary, "已截断") {
		t.Fatal("small actual output lost from model analysis")
	}
	for i := 0; i < 31; i++ {
		run.Steps = append(run.Steps, store.WorkflowStepRun{StepID: "large", Status: "completed", Stdout: strings.Repeat("large", 3000), Stderr: strings.Repeat("error", 3000)})
	}
	if summary := formatWorkflowRunAnswer(run); len(summary) > 40000 || !strings.Contains(summary, "已截断") {
		t.Fatalf("analysis context not bounded: %d", len(summary))
	}
}

func TestWorkflowStepSpecialistResumesFromParentWorkflow(t *testing.T) {
	s, saved, e, _, _ := adaptiveFixture(t, "no_verification")
	run, err := workflow.Start(context.Background(), s, saved, "desktop", e, nil)
	if err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err = specialistCommand(context.Background(), s, []string{"tasks"}, nil, &out, io.Discard); err != nil {
		t.Fatal(err)
	}
	var tasks []struct {
		ID                  string `json:"id"`
		CheckpointAvailable bool   `json:"checkpoint_available"`
		ResumeAvailable     bool   `json:"resume_available"`
		WorkflowRunID       string `json:"workflow_run_id"`
	}
	if err = json.Unmarshal(out.Bytes(), &tasks); err != nil || len(tasks) != 1 || !tasks[0].CheckpointAvailable || tasks[0].ResumeAvailable || tasks[0].WorkflowRunID != run.ID {
		t.Fatalf("workflow recovery incorrectly offered standalone resume: %s %v", out.String(), err)
	}
	approved := false
	_, err = resumeSpecialist(context.Background(), s, e.Service, nil, specialistResumeInput{TaskID: tasks[0].ID}, func(string, string, string) (bool, error) { approved = true; return true, nil })
	if err == nil || !strings.Contains(err.Error(), run.ID) || approved {
		t.Fatalf("parent workflow gate missing: %v %v", err, approved)
	}
}

func TestWorkflowV2UnknownAndFailedCommandsAreNotCompleted(t *testing.T) {
	s, _, e, m, remote := adaptiveFixture(t, "recovery")
	def := workflow.DefinitionV2{Version: 2, Name: "v2-restart", Description: "恢复测试服务", Nodes: []workflow.NodeV2{{ID: "restart", Name: "恢复测试服务", Kind: "ssh_command", Target: &workflow.ValueV2{Type: "string", Literal: "host"}, Command: &workflow.ValueV2{Type: "string", Literal: "original-restart"}, OutputType: "object"}}}
	body, _ := json.Marshal(def)
	saved, err := s.CreateWorkflowV2(context.Background(), e.Lake.ID, def.Name, def.Description, body)
	if err != nil {
		t.Fatal(err)
	}
	run, err := workflow.StartV2(context.Background(), s, saved, "desktop", e.runtime, func(context.Context, workflow.NodeV2, json.RawMessage) (bool, error) { return true, nil })
	if err != nil || run.Status != "completed" || m.calls != 5 || !strings.Contains(string(run.Nodes[0].Result), "verification") {
		t.Fatalf("v2 recovery: %+v %v", run, err)
	}
	remote.unknown = true
	m.calls = 0
	run, err = workflow.StartV2(context.Background(), s, saved, "desktop", e.runtime, func(context.Context, workflow.NodeV2, json.RawMessage) (bool, error) { return true, nil })
	if err != nil || run.Status != "failed" || run.Nodes[0].Status != "unknown" || m.calls != 0 {
		t.Fatalf("v2 unknown replay/completion: %+v %v", run, err)
	}
}
