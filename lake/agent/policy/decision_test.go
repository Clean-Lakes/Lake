package policy

import (
	"context"
	"errors"
	"testing"

	"github.com/cloudwego/eino/lake/agent"
)

type fakeBroker struct {
	decision agent.PermissionDecision
	requests int
}

func (b *fakeBroker) Request(_ context.Context, request agent.PermissionRequest) (agent.PermissionDecision, error) {
	b.requests++
	b.decision.RequestID = request.ID
	return b.decision, nil
}

func TestDecideDeniesScopeEscapeAndUnboundCodeWrite(t *testing.T) {
	scope := agent.RunScope{LakeID: "lake", ToolNames: []string{"edit"}, ProjectRoot: "/work/project"}
	input := Input{Spec: agent.ToolSpec{Name: "edit", Capability: "write"}, Scope: scope, Origin: "model", ProjectBound: true, ProjectPath: "/work/project/file.go"}
	if decision := Decide(input); decision.Outcome != agent.PermissionAsk {
		t.Fatalf("code write should ask: %+v", decision)
	}
	input.ProjectPath = "/work/elsewhere/file.go"
	if decision := Decide(input); decision.Outcome != agent.PermissionDeny {
		t.Fatalf("project escape allowed: %+v", decision)
	}
	input.ProjectPath = "/work/project/file.go"
	input.ProjectBound = false
	if decision := Decide(input); decision.Outcome != agent.PermissionDeny {
		t.Fatalf("unbound write allowed: %+v", decision)
	}
}

func TestDecideChecksFrozenAuthorizedSSHAndGlobalPolicy(t *testing.T) {
	input := Input{Spec: agent.ToolSpec{Name: "ssh", Capability: "execute"}, Scope: agent.RunScope{LakeID: "lake", AllTools: true, ResourceIDs: []string{"host"}}, Origin: "model", ResourceID: "host", ResourceFrozen: true, ResourceAuthorized: true, SSHRisk: "read", SilentSSHRead: true}
	if decision := Decide(input); decision.Outcome != agent.PermissionAllow {
		t.Fatalf("silent read denied: %+v", decision)
	}
	input.ResourceFrozen = false
	if decision := Decide(input); decision.Outcome != agent.PermissionDeny {
		t.Fatalf("new resource escaped frozen scope: %+v", decision)
	}
	input.ResourceFrozen = true
	input.SSHRisk = "write"
	if decision := Decide(input); decision.Outcome != agent.PermissionAsk {
		t.Fatalf("write should ask: %+v", decision)
	}
}

func TestAuthorizeUsesBrokerForExternalTool(t *testing.T) {
	input := Input{Spec: agent.ToolSpec{Name: "mcp_tool", Capability: "external"}, Scope: agent.RunScope{LakeID: "lake", AllTools: true}, Origin: "model", Request: agent.PermissionRequest{ID: "request-1", ToolName: "mcp_tool"}}
	broker := &fakeBroker{decision: agent.PermissionDecision{Outcome: agent.PermissionAllow}}
	if err := Authorize(context.Background(), input, broker); err != nil || broker.requests != 1 {
		t.Fatalf("approved tool rejected: err=%v count=%d", err, broker.requests)
	}
	broker.decision.Outcome = agent.PermissionDeny
	if err := Authorize(context.Background(), input, broker); !errors.Is(err, ErrDenied) {
		t.Fatalf("denied tool executed: %v", err)
	}
}

func TestDirectUserWorkflowActionUsesInvocationAsAuthorization(t *testing.T) {
	input := Input{Spec: agent.ToolSpec{Name: "lake_workflow_run", Capability: "workflow"}, Scope: agent.RunScope{LakeID: "lake", ToolNames: []string{"lake_workflow_run"}}, Origin: "cli", DirectUserAction: true, Request: agent.PermissionRequest{Target: "lake/workflow"}}
	if got := Decide(input); got.Outcome != agent.PermissionAllow {
		t.Fatalf("direct CLI workflow denied: %+v", got)
	}
	input.Origin = "desktop"
	if got := Decide(input); got.Outcome != agent.PermissionAllow {
		t.Fatalf("direct desktop workflow denied: %+v", got)
	}
	input.Origin = "model"
	if got := Decide(input); got.Outcome != agent.PermissionAsk {
		t.Fatalf("model action bypassed approval: %+v", got)
	}
}
