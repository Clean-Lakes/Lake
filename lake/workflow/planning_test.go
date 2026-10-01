package workflow

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/cloudwego/eino/lake/store"
)

type planningSSH struct {
	SSHExecutor
	calls int
	plan  func(context.Context, Definition, []store.WorkflowRun) (PlanProposal, error)
}

func (p *planningSSH) PlanWorkflow(ctx context.Context, def Definition, history []store.WorkflowRun) (PlanProposal, error) {
	p.calls++
	return p.plan(ctx, def, history)
}

func planningDefinition() Definition {
	return Definition{Name: "scan", Steps: []Step{
		{ID: "dirs", Name: "目录扫描", Kind: "ssh_command", Resource: "host", Command: "du -xhd1 /"},
		{ID: "files", Name: "大文件扫描", Kind: "ssh_command", Resource: "host", Command: "find / -xdev -type f -size +500M"},
	}}
}

func scanPlan() PlanProposal {
	return PlanProposal{Adjustments: []PlanChange{
		{StepID: "dirs", TimeoutSeconds: 300, Reason: "扫描目录需要更长时间"},
		{StepID: "files", TimeoutSeconds: 600, AddDependsOn: []string{"dirs"}, Reason: "顺序扫描减少磁盘竞争"},
	}}
}

func TestPlanningPersistsBeforeExecutionAndKeepsSavedDefinition(t *testing.T) {
	def := planningDefinition()
	s, saved := savedWorkflow(t, def)
	original := string(saved.Spec)
	remote := &fakeSSH{}
	planner := &planningSSH{SSHExecutor: remote, plan: func(context.Context, Definition, []store.WorkflowRun) (PlanProposal, error) { return scanPlan(), nil }}
	var progress []*PlanningReview
	run, err := Start(context.Background(), s, saved, "desktop", planner, func(p Progress) {
		if p.Planning != nil {
			progress = append(progress, p.Planning)
		}
		if p.StepStatus == "running" {
			persisted, err := s.GetWorkflowRun(context.Background(), p.RunID)
			if err != nil || !strings.Contains(string(persisted.Spec), `"timeout_seconds":600`) {
				t.Fatalf("command dispatched before plan commit: %s %v", persisted.Spec, err)
			}
		}
	})
	if err != nil || run.Status != "completed" || planner.calls != 1 || len(progress) != 1 {
		t.Fatalf("run=%+v plans=%d err=%v", run, planner.calls, err)
	}
	if !reflect.DeepEqual(remote.calls, []string{"command:host:du -xhd1 /", "command:host:find / -xdev -type f -size +500M"}) {
		t.Fatalf("serial plan did not govern dispatch: %v", remote.calls)
	}
	var effective Definition
	json.Unmarshal(run.Spec, &effective)
	if effective.Planning.Status != "adjusted" || effective.Steps[0].TimeoutSeconds != 300 || !reflect.DeepEqual(effective.Planning.Adjustments[1].WaitFor, []string{"目录扫描"}) {
		t.Fatalf("plan lost: %s", run.Spec)
	}
	unchanged, _ := s.GetWorkflow(context.Background(), saved.ID)
	if string(unchanged.Spec) != original {
		t.Fatal("saved task rewritten")
	}
	if err := s.SavePendingWorkflowPlan(context.Background(), run.ID, saved.Spec, json.RawMessage(`{}`)); err == nil {
		t.Fatal("settled run plan rewritten")
	}
	events, _ := s.ListWorkflowEvents(context.Background(), run.ID)
	planned, firstStep := -1, -1
	for i, event := range events {
		if event.Status == "planned" {
			planned = i
		}
		if event.StepID != "" && firstStep < 0 {
			firstStep = i
		}
	}
	if planned < 0 || firstStep <= planned {
		t.Fatalf("plan not recorded before execution: %+v", events)
	}
}

func TestPlanningExtendedTimeoutReachesRealSSHTransport(t *testing.T) {
	def := Definition{Name: "slow", Steps: []Step{{ID: "scan", Name: "扫描", Kind: "ssh_command", Resource: "host", Command: "scan"}}}
	s, saved := savedWorkflow(t, def)
	remote := slowTestSSH(t)
	planner := &planningSSH{SSHExecutor: remote, plan: func(context.Context, Definition, []store.WorkflowRun) (PlanProposal, error) {
		return PlanProposal{Adjustments: []PlanChange{{StepID: "scan", TimeoutSeconds: 21, Reason: "给予扫描足够执行时间"}}}, nil
	}}
	run, err := Start(context.Background(), s, saved, "cli", planner, nil)
	if err != nil || run.Status != "completed" || run.Steps[0].Stdout != "scan started\nscan completed\n" || remote.executions.Load() != 1 {
		t.Fatalf("model plan did not reach transport: %+v %v", run, err)
	}
}

func TestPlanningFixedInvalidAndCancel(t *testing.T) {
	for _, mode := range []string{"fixed", "invalid", "cancel"} {
		t.Run(mode, func(t *testing.T) {
			def := planningDefinition()
			if mode == "fixed" {
				def.ExecutionMode = "fixed"
			}
			s, saved := savedWorkflow(t, def)
			remote := &fakeSSH{}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			p := &planningSSH{SSHExecutor: remote, plan: func(context.Context, Definition, []store.WorkflowRun) (PlanProposal, error) {
				if mode == "cancel" {
					cancel()
					return PlanProposal{}, ctx.Err()
				}
				proposal := scanPlan()
				proposal.Adjustments[0].AddDependsOn = []string{"files"}
				return proposal, nil // creates a cycle; the entire proposal must fail
			}}
			run, err := Start(ctx, s, saved, "cli", p, nil)
			if err != nil {
				t.Fatal(err)
			}
			expected, _ := BindTargets(def, "", nil, nil)
			expectedJSON, _ := json.Marshal(expected)
			if mode == "fixed" && (p.calls != 0 || run.Status != "completed" || string(run.Spec) != string(expectedJSON)) {
				t.Fatalf("fixed changed: %+v", run)
			}
			if mode == "cancel" && (len(remote.calls) != 0 || run.Status != "interrupted") {
				t.Fatalf("cancel executed: %+v %v", run, remote.calls)
			}
			if mode == "invalid" {
				var snapshot Definition
				json.Unmarshal(run.Spec, &snapshot)
				if snapshot.Planning.Status != "unavailable" || snapshot.Steps[0].TimeoutSeconds != 0 || len(snapshot.Steps[1].DependsOn) != 0 {
					t.Fatalf("partial invalid plan applied: %s", run.Spec)
				}
			}
		})
	}
}

func TestApplyPlanRejectsScopeAndBranchViolations(t *testing.T) {
	for _, scenario := range []string{"shorter", "too_long", "cycle", "missing", "other_host", "branch", "duplicate"} {
		t.Run(scenario, func(t *testing.T) {
			def, proposal := planningDefinition(), scanPlan()
			switch scenario {
			case "shorter":
				proposal.Adjustments[0].TimeoutSeconds = 10
			case "too_long":
				proposal.Adjustments[0].TimeoutSeconds = 3601
			case "cycle":
				proposal.Adjustments[0].AddDependsOn = []string{"files"}
			case "missing":
				proposal.Adjustments[0].StepID = "absent"
			case "other_host":
				def.Steps[1].Resource = "other"
			case "branch":
				def.Steps[1].When = "any_failure"
			case "duplicate":
				proposal.Adjustments[1].StepID = "dirs"
			}
			before, _ := json.Marshal(def)
			if _, _, err := ApplyPlan(def, proposal); err == nil {
				t.Fatal("unsafe plan accepted")
			}
			after, _ := json.Marshal(def)
			if string(before) != string(after) {
				t.Fatal("invalid plan mutated input")
			}
		})
	}
}

func TestPlanningHistoryAndResumeDoNotRewriteOrReplaySuccessfulSteps(t *testing.T) {
	def := planningDefinition()
	s, saved := savedWorkflow(t, def)
	remote := &fakeSSH{failCommand: true}
	planner := &planningSSH{SSHExecutor: remote, plan: func(context.Context, Definition, []store.WorkflowRun) (PlanProposal, error) { return scanPlan(), nil }}
	run, err := Start(context.Background(), s, saved, "cli", planner, nil)
	if err != nil || run.Status != "failed" {
		t.Fatalf("run=%+v %v", run, err)
	}
	prior := string(run.Spec)
	if _, err := Resume(context.Background(), s, run.ID, false, planner, nil); err == nil {
		t.Fatal("write resumed without verification")
	}
	remote.failCommand = false
	resumed, err := Resume(context.Background(), s, run.ID, true, planner, nil)
	if err != nil || resumed.Status != "completed" || planner.calls != 1 || string(resumed.Spec) != prior {
		t.Fatalf("resume replanned: %+v %v", resumed, err)
	}
	history, err := s.ListWorkflowHistory(context.Background(), saved.ID, "", 5)
	if err != nil || len(history) != 1 || string(history[0].Spec) != prior {
		t.Fatalf("history=%+v %v", history, err)
	}
	if err := s.SavePendingWorkflowPlan(context.Background(), run.ID, saved.Spec, json.RawMessage(`{}`)); err == nil {
		t.Fatal("history rewritten")
	}
}

func TestPlanningEvidenceRejectsChangedOperationAndInventedRun(t *testing.T) {
	def := planningDefinition()
	body, _ := json.Marshal(def)
	history := []store.WorkflowRun{{ID: "real", Spec: body, Steps: []store.WorkflowStepRun{{StepID: "dirs", Status: "unknown", Error: "context deadline exceeded"}}}}
	proposal := PlanProposal{Adjustments: []PlanChange{{StepID: "dirs", TimeoutSeconds: 300, Reason: "历史超时", EvidenceRunIDs: []string{"real"}}}}
	if err := ValidatePlanEvidence(def, proposal, history); err != nil {
		t.Fatal(err)
	}
	def.Steps[0].Resource = "other-host"
	if err := ValidatePlanEvidence(def, proposal, history); err == nil {
		t.Fatal("different target used as evidence")
	}
	def.Steps[0].Resource = "host"
	proposal.Adjustments[0].EvidenceRunIDs = []string{"invented"}
	if err := ValidatePlanEvidence(def, proposal, history); err == nil {
		t.Fatal("invented run used as evidence")
	}
}

var _ SSHExecutor = (*planningSSH)(nil)
var _ PlanningExecutor = (*planningSSH)(nil)
