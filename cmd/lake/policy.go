package main

import (
	"context"
	"crypto/sha256"
	"fmt"
	"path/filepath"

	"github.com/cloudwego/eino/lake/agent"
	"github.com/cloudwego/eino/lake/agent/policy"
	"github.com/cloudwego/eino/lake/operate"
	"github.com/cloudwego/eino/lake/store"
)

type policyAuditContextKey struct{}

type policyAudit struct {
	store *store.Store
	runID string
}

func withPolicyAudit(ctx context.Context, s *store.Store, runID string) context.Context {
	return context.WithValue(ctx, policyAuditContextKey{}, policyAudit{store: s, runID: runID})
}

type callbackApprovalBroker struct {
	approve func(string, string, string) (bool, error)
	kind    string
	path    string
	detail  string
}

func (b callbackApprovalBroker) Request(_ context.Context, request agent.PermissionRequest) (agent.PermissionDecision, error) {
	if b.approve == nil {
		return agent.PermissionDecision{RequestID: request.ID, Outcome: agent.PermissionDeny}, nil
	}
	approved, err := b.approve(b.kind, b.path, b.detail)
	if err != nil {
		return agent.PermissionDecision{}, err
	}
	outcome := agent.PermissionDeny
	if approved {
		outcome = agent.PermissionAllow
	}
	return agent.PermissionDecision{RequestID: request.ID, Outcome: outcome}, nil
}

// The desktop approval gate and CLI yes/no prompt both enter this broker.
// Only the digest crosses the policy boundary; the UI retains the full preview.
func authorizeToolAction(ctx context.Context, lakeID, projectRoot, toolName, capability, path, kind, detail string, approve func(string, string, string) (bool, error)) error {
	target := path
	if projectRoot != "" && !filepath.IsAbs(target) {
		target = filepath.Join(projectRoot, target)
	}
	input := policy.Input{
		Spec:   agent.ToolSpec{Name: toolName, Capability: capability},
		Scope:  agent.RunScope{LakeID: lakeID, AllTools: true, ProjectRoot: projectRoot},
		Origin: "model", ProjectBound: projectRoot != "",
	}
	if projectRoot != "" {
		input.ProjectPath = target
	}
	return authorizePolicyAction(ctx, input, path, kind, detail, approve)
}

// Resource-backed execution must supply the actual frozen resource to policy.
// The service checks its current authorization again immediately before SSH.
func authorizeResourceToolAction(ctx context.Context, service *operate.Service, resourceName, toolName, capability, kind, detail string, approve func(string, string, string) (bool, error)) error {
	resource, err := service.Store.ResolveResource(ctx, service.Lake.Name+"/"+resourceName)
	if err != nil {
		return err
	}
	if resource.LakeID != service.Lake.ID || resource.Kind != "host" {
		return policy.ErrDenied
	}
	_, frozen := service.Anchors[resource.ID]
	input := policy.Input{
		Spec:   agent.ToolSpec{Name: toolName, Capability: capability},
		Scope:  agent.RunScope{LakeID: service.Lake.ID, ToolNames: []string{toolName}, ResourceIDs: []string{resource.ID}},
		Origin: "model", ResourceID: resource.ID, ResourceFrozen: frozen, ResourceAuthorized: resource.ExecuteAuthz,
	}
	return authorizePolicyAction(ctx, input, service.Lake.Name+"/"+resourceName, kind, detail, approve)
}

func authorizePolicyAction(ctx context.Context, input policy.Input, path, kind, detail string, approve func(string, string, string) (bool, error)) error {
	id, err := store.NewActionID()
	if err != nil {
		return err
	}
	digest := sha256.Sum256([]byte(detail))
	request := agent.PermissionRequest{ID: id, ToolName: input.Spec.Name, Capability: input.Spec.Capability, Target: path, ArgumentsSHA: fmt.Sprintf("%x", digest)}
	input.Request = request
	var audit *policyAudit
	if value, ok := ctx.Value(policyAuditContextKey{}).(policyAudit); ok && value.store != nil {
		audit = &value
	}
	logDecision := func(event string) error {
		if audit == nil {
			return nil
		}
		_, err := audit.store.AppendJournal(ctx, store.JournalInput{
			RunID: audit.runID, ActionID: id, Actor: "agent", TargetPath: path,
			Tool: input.Spec.Name, Risk: "write", Event: event, Detail: "arguments_sha256=" + request.ArgumentsSHA,
		})
		return err
	}
	if err := logDecision("requested"); err != nil {
		return err
	}
	err = policy.Authorize(ctx, input, callbackApprovalBroker{approve: approve, kind: kind, path: path, detail: detail})
	if err != nil {
		if logErr := logDecision("denied"); logErr != nil {
			return logErr
		}
		return err
	}
	return logDecision("approved")
}

// A direct CLI command or desktop button is already a concrete user action.
// The policy still checks its origin and scope, and the journal stores only a digest.
func authorizeDirectWorkflowAction(ctx context.Context, s *store.Store, lakeID, toolName, target, origin, detail string) error {
	id, err := store.NewActionID()
	if err != nil {
		return err
	}
	digest := sha256.Sum256([]byte(detail))
	request := agent.PermissionRequest{ID: id, ToolName: toolName, Capability: "workflow", Target: target, ArgumentsSHA: fmt.Sprintf("%x", digest)}
	runID := ""
	if value, ok := ctx.Value(policyAuditContextKey{}).(policyAudit); ok {
		runID = value.runID
	}
	journal := func(event string) error {
		_, err := s.AppendJournal(ctx, store.JournalInput{RunID: runID, ActionID: id, Actor: "cli", TargetPath: target, Tool: toolName, Risk: "write", Event: event, Detail: "arguments_sha256=" + request.ArgumentsSHA})
		return err
	}
	if err := journal("requested"); err != nil {
		return err
	}
	err = policy.Authorize(ctx, policy.Input{
		Spec: agent.ToolSpec{Name: toolName, Capability: "workflow"}, Scope: agent.RunScope{LakeID: lakeID, ToolNames: []string{toolName}},
		Origin: origin, DirectUserAction: true, Request: request,
	}, nil)
	if err != nil {
		if logErr := journal("denied"); logErr != nil {
			return logErr
		}
		return err
	}
	return journal("approved")
}
