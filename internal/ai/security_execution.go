package ai

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/Clean-Lakes/Lake/internal/security"
)

// invoke is the single runtime tool entrance. Configured projects cannot reach
// legacy execution via an early memory/session/Pilot/attachment branch.
func (e *Engine) invoke(ctx context.Context, s *session, c Config, call Call) (any, error) {
	if err := e.CheckSecurityRuntime(); err != nil {
		return nil, &ToolNotExecutedError{Err: err}
	}
	if s == nil {
		return nil, &ToolNotExecutedError{Err: errors.New("execution session is unavailable")}
	}
	if err := e.checkSuperModelDomain(ctx, ownSessionID(s), c); err != nil {
		return nil, &ToolNotExecutedError{Err: err}
	}
	if err := e.checkSuperAssignmentContext(ctx); err != nil {
		return nil, &ToolNotExecutedError{Err: err}
	}
	if c.superRole == "router" {
		return e.invokeSuperRouter(ctx, s, c, call)
	}
	if c.superRole == "worker" {
		if _, ok := ctx.Value(superAssignmentContextKey{}).(SuperAssignmentToken); !ok {
			return nil, &ToolNotExecutedError{Err: errors.New("superagent: Worker assignment required")}
		}
		found := false
		for _, t := range e.sessionCatalog(ctx, ownSessionID(s), c) {
			if t.Name == call.Name {
				found = true
				break
			}
		}
		if !found {
			return nil, &ToolNotExecutedError{Err: errors.New("superagent: tool unavailable to Worker")}
		}
		managed, err := e.SecurityProjectManaged(ctx, configSecurityProject(c))
		if err != nil {
			return nil, err
		}
		if !managed {
			return nil, &ToolNotExecutedError{Err: errors.New("superagent: Worker requires current Security policy")}
		}
		if call.Name == "list_referenced_task_evidence" || call.Name == "read_referenced_task_evidence" {
			a, err := args(call)
			if err != nil {
				return nil, err
			}
			for _, tool := range referencedTaskEvidenceTools() {
				if tool.Name == call.Name {
					if err := validateTool(tool, a); err != nil {
						return nil, err
					}
				}
			}
			if call.Name == "list_referenced_task_evidence" {
				return e.ListReferencedTaskEvidence(ctx, ownSessionID(s), str(a["task_id"]), str(a["cursor"]), num(a["limit"], 20))
			}
			return e.ReadReferencedTaskEvidence(ctx, ownSessionID(s), str(a["task_id"]), str(a["evidence_id"]), str(a["reference_id"]), num(a["offset"], 0), num(a["limit"], 2048))
		}
	}
	configured, err := e.securityPolicyConfigured(configSecurityProject(c))
	if err != nil {
		return nil, &ToolNotExecutedError{Err: err}
	}
	s.mu.Lock()
	managed := s.state.SecurityManaged
	s.mu.Unlock()
	if !configured && !managed && c.securityExecution == nil {
		value, legacyErr := e.invokeLegacy(ctx, s, c, call)
		e.recordSecurityShadowCall(ctx, s, c, call, legacyErr == nil)
		return value, legacyErr
	}
	if !configured {
		return nil, &ToolNotExecutedError{Err: errors.New("security: managed policy unavailable")}
	}
	// These operate on the caller's existing goal only. They never grant access
	// or perform resource I/O; wait adapters still need their own future permit.
	if workToolName(call.Name) {
		if c.Model.Key != "" && strings.Contains(call.Arguments, c.Model.Key) {
			return nil, errors.New("tool arguments cannot contain model credentials")
		}
		a, parseErr := args(call)
		if parseErr != nil {
			return nil, parseErr
		}
		return e.invokeWorkTool(ctx, s, c, call, a)
	}
	return e.invokeManaged(ctx, s, c, call)
}

func (e *Engine) invokeManaged(ctx context.Context, s *session, c Config, call Call) (result any, err error) {
	if err = ctx.Err(); err != nil {
		return nil, &ToolNotExecutedError{Err: err}
	}
	if err = e.checkNaturalRecall(ctx, s, c); err != nil {
		return nil, &ToolNotExecutedError{Err: err}
	}
	if c.Model.Key != "" && strings.Contains(call.Arguments, c.Model.Key) {
		return nil, errors.New("tool arguments cannot contain model credentials")
	}
	a, err := args(call)
	if err != nil {
		return nil, err
	}
	for key := range a {
		if strings.HasPrefix(key, "__") {
			return nil, errors.New("reserved tool argument")
		}
	}
	if e.worker != nil {
		c, err = e.scopedChildConfig(c, a)
		if err != nil {
			return nil, err
		}
	}
	s.mu.Lock()
	sessionID := s.state.View.Session
	s.mu.Unlock()
	found := false
	for _, tool := range e.sessionCatalog(ctx, sessionID, c) {
		if tool.Name == call.Name {
			if err = validateTool(tool, a); err != nil {
				return nil, err
			}
			found = true
			break
		}
	}
	if !found {
		return nil, errors.New("tool unavailable in selected profile")
	}
	risk := ToolRisk(call.Name, a)
	if err = checkPlanOperation(c, call.Name, risk); err != nil {
		return nil, err
	}
	if err = pilotRoleAllowed(c, risk); err != nil {
		return nil, err
	}
	if err = e.checkSRECall(c, call, a); err != nil {
		return nil, err
	}
	if err = e.checkPilotCall(c, call, a); err != nil {
		return nil, err
	}
	if err = e.PrepareSREOperation(c, call, risk); err != nil {
		return nil, err
	}
	defer func() { e.finishSREPreparation(c, call, err) }()
	defer func() { result, err = e.recordSREToolResult(c, call, a, result, err) }()
	if e.worker != nil {
		e.worker.mu.Lock()
		e.worker.calls++
		calls := e.worker.calls
		e.worker.mu.Unlock()
		if !fullSREAgent(c) && calls > agentCallLimit(c) {
			return nil, errors.New("子 Agent 工具调用预算已达到上限")
		}
		if err = e.worker.parent.updateAgent(e.worker, func(run *AgentRun) { run.ToolCount = calls }); err != nil {
			return nil, err
		}
	}
	prepared, decision, err := e.PrepareCatalogOperation(ctx, sessionID, c, call, a)
	if err != nil {
		return nil, &ToolNotExecutedError{Err: err}
	}
	if err = e.recordSecurityShadowDecision(ctx, s, c, call, prepared, decision); err != nil {
		return nil, &ToolNotExecutedError{Err: err}
	}
	if prepared == nil || decision.Effect == security.EffectDeny {
		return nil, &ToolNotExecutedError{Err: &securityPermitError{Decision: decision}}
	}
	a, c = prepared.executionArgs, prepared.executionConfig
	if c.Permissions != nil && c.Permissions.DenyLocalExecution {
		for _, resource := range prepared.descriptor.Resources {
			if resource.Local {
				return nil, &ToolNotExecutedError{Err: errors.New("当前会话禁止本机执行")}
			}
		}
	}
	ctx = SecurityOperationContext(ctx, prepared)
	descriptor := prepared.descriptor
	if descriptor.Proof == security.ProofOpaque && risk == "readonly" {
		risk = "write"
		if err = checkPlanOperation(c, call.Name, risk); err != nil {
			return nil, err
		}
		if err = pilotRoleAllowed(c, risk); err != nil {
			return nil, err
		}
	}
	var preview map[string]any
	target := "当前任务范围"
	if len(descriptor.Resources) == 1 {
		target = descriptor.Resources[0].ID
		for _, asset := range c.Assets {
			if asset.ID == target {
				target = asset.Name
				break
			}
		}
	}
	cardID := uid()
	s.mu.Lock()
	foundCard := false
	for i := range s.state.View.Cards {
		card := &s.state.View.Cards[i]
		if card.Type == "operation" && str(obj(card.Data)["call_id"]) == call.ID && (card.Status == "pending" || card.Status == "running") {
			cardID = card.ID
			card.Status = "running"
			foundCard = true
			break
		}
	}
	if !foundCard {
		s.state.View.Cards = append(s.state.View.Cards, Card{ID: cardID, Type: "operation", Title: call.Name, Data: map[string]any{"call_id": call.ID, "target": target, "risk": risk}, Status: "running", At: timestamp()})
	}
	s.mu.Unlock()
	defer func() {
		if errors.Is(err, errADKApprovalPending) {
			return
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		for i := range s.state.View.Cards {
			card := &s.state.View.Cards[i]
			if card.ID == cardID {
				card.Status = "completed"
				card.Content = redact(utf8Prefix(js(result), 32000), c)
				if err != nil {
					card.Status = "failed"
					card.Content = redact(err.Error(), c)
					var blocked *ToolNotExecutedError
					if errors.As(err, &blocked) {
						card.Status = "not_executed"
					}
				}
			}
		}
		e.notify(s, "operation", map[string]any{"card_id": cardID})
	}()
	if decision.Effect == security.EffectApprovalRequired || resumingNativeApproval(ctx) {
		preview, err = securityOperationApprovalPreview(c, prepared, target)
		if err != nil {
			return nil, &ToolNotExecutedError{Err: err}
		}
		proposal, proposalErr := e.prepareSecurityGrantConfirmation(ctx, s, c, call, prepared)
		if proposalErr != nil {
			return nil, proposalErr
		}
		if proposal != nil {
			preview = e.securityGrantApprovalPreview(c, proposal)
			ctx = withSecurityGrantConfirmation(ctx, proposal)
		}
		approval := &Approval{ID: uid(), Call: call, Kind: "operation", Target: target, Risk: risk, Fingerprint: prepared.digest, Preview: preview}
		if descriptor.RequireSingleConfirmation {
			approval.Confirmation = "执行 " + target
		}
		accepted, approvalErr := e.waitNativeApproval(ctx, s, c, approval)
		if approvalErr != nil {
			return nil, approvalErr
		}
		if !accepted {
			return nil, errors.New("user rejected this operation")
		}
		prepared, decision, err = e.PrepareCatalogOperation(ctx, sessionID, c, call, a)
		if err != nil {
			return nil, err
		}
		if prepared == nil || decision.Effect != security.EffectAllow {
			return nil, &ToolNotExecutedError{Err: &securityPermitError{Decision: decision}}
		}
		a, c = prepared.executionArgs, prepared.executionConfig
		descriptor = prepared.descriptor
		ctx = SecurityOperationContext(ctx, prepared)
	}
	if err = e.DispatchSREOperation(ctx, c, call); err != nil {
		return nil, err
	}
	defer func() { e.finishSREOperation(c, call, result, err) }()
	operation, err := e.dispatchNativeOperation(ctx, s, c, call, risk, target, prepared.digest)
	if err != nil {
		return nil, &ToolNotExecutedError{Err: err}
	}
	if operation == nil || operation.permit == nil {
		return nil, &ToolNotExecutedError{Err: errors.New("security: registered permit required")}
	}
	ctx = securityPermitContext(ctx, operation.permit)
	ctx = context.WithValue(ctx, runtimeSSHSessionKey{}, sessionID)
	ctx = context.WithValue(ctx, backgroundShellSourceKey{}, map[string]any{"resource_id": operation.ResourceID, "target": target, "parent_card_id": cardID, "call_id": call.ID})
	if descriptor.TargetKind == security.TargetResource || descriptor.TargetKind == security.TargetResourceSet {
		started := time.Now()
		defer func() { e.recordMemoryToolContext(s, c, call, operation.ResourceID, started, result, err) }()
	}
	defer func() {
		if persistErr := e.finishNativeOperation(operation, c, result, err); persistErr != nil {
			err = persistErr
		}
	}()
	if prepared.command != nil {
		return e.executeFrozenCommand(ctx, c, a, *prepared.command)
	}
	if prepared.read != nil && !strings.HasPrefix(call.Name, "observe_") {
		return e.executeSecurityReadProbe(ctx, c, call.Name, a)
	}
	if call.Name == "shell" && a["run_in_background"] == true {
		return e.startManagedShell(ctx, c, a, str(a["command"]), obj(ctx.Value(backgroundShellSourceKey{})))
	}
	if call.Name == "shell" && len(descriptor.Resources) == 1 && descriptor.Resources[0].Local {
		return e.command(ctx, c, a, str(a["command"]))
	}
	if descriptor.Proof == security.ProofStructured && descriptor.Scope.FileRoot != "" && (call.Name == "read" || call.Name == "ls") {
		return e.executeSecurityLocalFile(ctx, c, call.Name, a)
	}
	if call.Name == "list_mcp_servers" || call.Name == "list_mcp_tools" || call.Name == "call_mcp_tool" {
		return e.ExecuteSecurityMCP(ctx, call.Name, a)
	}
	switch call.Name {
	case "pilot_offer_directions":
		return e.offerPilotDirections(ctx, s, c, call)
	case "pilot_read_recovery":
		return e.pilotReadRecovery(c, call)
	case "sre_collaborate":
		return e.prepareSREHandoff(s, c, call)
	case "sre_reply":
		return e.prepareSREReply(s, c, call)
	case "sre_team_update", "sre_team_read":
		return e.invokeSRETeam(c, call.Name, a)
	case "delegate_investigation":
		var input struct {
			Tasks []investigationSpec `json:"tasks"`
		}
		if err = json.Unmarshal([]byte(call.Arguments), &input); err != nil {
			return nil, err
		}
		if _, err = e.runInvestigations(ctx, s, c, input.Tasks); err != nil {
			return nil, err
		}
		return e.investigationReports(s, false), nil
	case "read_investigation":
		if len(a) == 0 {
			return e.investigationReports(s, true), nil
		}
		value, _, readErr := e.readAgentEvidence(s, a)
		return value, readErr
	case "read_evidence":
		if e.worker != nil {
			return e.observation(ctx, c, call.Name, a)
		}
	}
	if naturalRecallTool(call.Name) {
		return e.invokeNaturalRecall(ctx, s, c, call)
	}
	if sessionTool(call.Name) {
		return e.invokeSessionTool(ctx, s, c, call, a)
	}
	if memoryTool(call.Name) {
		if !c.MemoryEnabled || c.MemoryProjectID == "" || e.Bridge == nil || e.worker != nil && (c.MemorySchemaVersion == 2 || c.sre == nil || !c.sre.FullTools) {
			return nil, &ToolNotExecutedError{Err: errors.New("project memory unavailable")}
		}
		return e.bridgeCall(ctx, sessionID, call.Name, a, true)
	}
	ref := str(a["asset_ref"])
	if ref == "" && len(descriptor.Resources) == 1 {
		ref = descriptor.Resources[0].ID
	}
	policyContext := map[string]any{"asset_ref": ref, "runtime": c.Runtime}
	return e.executeResourceTool(ctx, s, c, call, a, risk, ref, sessionID, policyContext, nil, true)
}

// RequireSecurityBridgeContext is used at the actual host bridge, including its
// early branches. approved is never consulted as proof of managed authority.
func (e *Engine) RequireSecurityBridgeContext(ctx context.Context, projectID, sessionID, name string) error {
	if binding, ok := ctx.Value(superMemoryReadKey{}).(superMemoryReadBinding); ok && binding.sessionID == sessionID && binding.projectID == projectID && (name == "project_memory_index" || name == "list_project_memories" || name == "read_project_memory") {
		if err := e.CheckSecurityMemoryEligibility(ctx, projectID, SecurityMemoryRead); err != nil {
			return err
		}
		return e.CheckSecurityMemoryEligibility(ctx, projectID, SecurityMemoryUse)
	}
	configured, err := e.securityPolicyConfigured(projectID)
	if err != nil {
		return err
	}
	if !configured {
		return nil
	}
	switch name {
	case "policy", "terminal_capabilities", "resource_import_assets", "work_release_capability":
		return nil
	}
	p, _ := ctx.Value(securityPermitContextKey{}).(*SecurityPermit)
	if p == nil || p.digest == "" || p.operation.ProjectID != projectID || p.operation.SessionID != sessionID {
		return errors.New("security: host bridge requires a registered execution permit")
	}
	return e.ValidateSecurityPermitAtIO(ctx, projectID, sessionID)
}

// The actual I/O adapters repeat the current permission check. Calling a
// database/file/process adapter directly cannot bypass the tool entrance.
func (e *Engine) requireSecurityAdapterContext(ctx context.Context, c Config) error {
	projectID := configSecurityProject(c)
	p, _ := ctx.Value(securityPermitContextKey{}).(*SecurityPermit)
	if p != nil && projectID == "" {
		projectID = p.operation.ProjectID
	}
	configured, err := e.securityPolicyConfigured(projectID)
	if err != nil {
		return &ToolNotExecutedError{Err: err}
	}
	if !configured && c.securityExecution == nil && p == nil {
		return nil
	}
	if p == nil || p.digest == "" || p.operation.ProjectID != projectID {
		return &ToolNotExecutedError{Err: errors.New("security: actual I/O requires a registered permit")}
	}
	if err = e.ValidateSecurityPermitAtIO(ctx, projectID, p.operation.SessionID); err != nil {
		return &ToolNotExecutedError{Err: err}
	}
	return nil
}
