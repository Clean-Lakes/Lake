package policy

import (
	"context"
	"errors"
	"path/filepath"
	"strings"

	"github.com/cloudwego/eino/lake/agent"
)

var (
	ErrDenied           = errors.New("工具操作未获授权")
	ErrApprovalRequired = errors.New("工具操作需要批准")
)

type ApprovalBroker interface {
	Request(context.Context, agent.PermissionRequest) (agent.PermissionDecision, error)
}

type Input struct {
	Spec               agent.ToolSpec
	Scope              agent.RunScope
	Origin             string
	DirectUserAction   bool
	Request            agent.PermissionRequest
	ResourceID         string
	ResourceFrozen     bool
	ResourceAuthorized bool
	ProjectBound       bool
	ProjectPath        string
	SSHRisk            string
	SilentSSHRead      bool
	SilentSSHCommand   bool
}

func decision(input Input, outcome agent.PermissionOutcome, reason string) agent.PermissionDecision {
	return agent.PermissionDecision{RequestID: input.Request.ID, Outcome: outcome, Reason: reason}
}

// Decide is a preflight check. Runtime services must check current resource and
// path state again immediately before execution; an approval is not a scope grant.
func Decide(input Input) agent.PermissionDecision {
	if input.Scope.LakeID == "" || input.Spec.Name == "" || (input.Origin != "model" && input.Origin != "cli" && input.Origin != "workflow" && input.Origin != "desktop") {
		return decision(input, agent.PermissionDeny, "invalid scope, tool, or origin")
	}
	if !input.Scope.AllTools && !contains(input.Scope.ToolNames, input.Spec.Name) {
		return decision(input, agent.PermissionDeny, "tool outside run scope")
	}
	if input.ResourceID != "" {
		if !input.Scope.AllResources && !contains(input.Scope.ResourceIDs, input.ResourceID) {
			return decision(input, agent.PermissionDeny, "resource outside run scope")
		}
		if !input.ResourceFrozen || !input.ResourceAuthorized {
			return decision(input, agent.PermissionDeny, "resource not frozen or authorized")
		}
	}
	if input.ProjectPath != "" {
		if !input.ProjectBound || !insideProject(input.Scope.ProjectRoot, input.ProjectPath) {
			return decision(input, agent.PermissionDeny, "project path outside bound scope")
		}
	}
	if input.SSHRisk != "" {
		if input.ResourceID == "" {
			return decision(input, agent.PermissionDeny, "SSH resource missing")
		}
		if input.SSHRisk == "read" && input.SilentSSHRead || input.SSHRisk == "write" && input.SilentSSHCommand {
			return decision(input, agent.PermissionAllow, "global silent SSH policy")
		}
		return decision(input, agent.PermissionAsk, "SSH operation requires approval")
	}
	if input.DirectUserAction && (input.Origin == "cli" || input.Origin == "desktop") && input.Spec.Capability == "workflow" && input.Request.Target != "" {
		return decision(input, agent.PermissionAllow, "explicit user workflow action")
	}
	switch input.Spec.Capability {
	case "read", "delegate", "user_input":
		return decision(input, agent.PermissionAllow, "")
	case "write", "execute":
		if input.ResourceID == "" && input.ProjectPath == "" {
			return decision(input, agent.PermissionDeny, "write target is unbound")
		}
		return decision(input, agent.PermissionAsk, "write or execution requires approval")
	case "external", "workflow":
		return decision(input, agent.PermissionAsk, "external or workflow operation requires approval")
	default:
		return decision(input, agent.PermissionDeny, "unknown tool capability")
	}
}

func Authorize(ctx context.Context, input Input, broker ApprovalBroker) error {
	preflight := Decide(input)
	switch preflight.Outcome {
	case agent.PermissionAllow:
		return nil
	case agent.PermissionDeny:
		return ErrDenied
	case agent.PermissionAsk:
		if broker == nil || input.Request.ID == "" {
			return ErrApprovalRequired
		}
		answer, err := broker.Request(ctx, input.Request)
		if err != nil {
			return err
		}
		if answer.RequestID != input.Request.ID || answer.Outcome != agent.PermissionAllow {
			return ErrDenied
		}
		return nil
	default:
		return ErrDenied
	}
}

func insideProject(root, target string) bool {
	if !filepath.IsAbs(root) || !filepath.IsAbs(target) {
		return false
	}
	rel, err := filepath.Rel(filepath.Clean(root), filepath.Clean(target))
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

func contains(items []string, candidate string) bool {
	for _, item := range items {
		if item == candidate {
			return true
		}
	}
	return false
}
