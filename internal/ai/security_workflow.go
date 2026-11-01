package ai

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"time"

	"github.com/Clean-Lakes/Lake/internal/security"
	"gorm.io/gorm"
)

type SecurityWorkflowStep struct {
	ID          string   `json:"id"`
	Title       string   `json:"title"`
	Role        string   `json:"role"`
	ResourceIDs []string `json:"resourceIds"`
	DependsOn   []string `json:"dependsOn"`
}

// The host binds this definition to the actual immutable workflow template.
// Acceptance is explicitly confirmed; free-form goal text is never compiled
// into an implicit success condition or an executable verification script.
type SecurityWorkflowDefinition struct {
	ProjectID, WorkflowID string
	TemplateVersion       int64
	TemplateDigest        string
	Revision              int64
	Goal                  string
	Steps                 []SecurityWorkflowStep
	Acceptance            map[string]WorkStepContract
}

type SecurityWorkflowDefinitionAction struct {
	ActorID, ActionID, ProjectID, WorkflowID string
	ExpectedRevision                         int64
}

type securityWorkflowDefinitionRow struct {
	ProjectID                                    string `gorm:"primaryKey"`
	WorkflowID                                   string `gorm:"primaryKey"`
	StoreID, RecoveryEpoch, TemplateDigest, Data string
	TemplateVersion, Revision                    int64
}

func (securityWorkflowDefinitionRow) TableName() string { return "security_workflow_definitions" }

type SecurityWorkflowRunInput struct {
	RunID, WorkflowID, ProjectID, SessionID, TemplateDigest       string
	TemplateVersion                                               int64
	ActorID, ActionID, SourceMessageID, SourceKind, SourceEventID string
	ExpiresAt                                                     time.Time
}

type SecurityWorkflowRunBinding struct {
	RunID, WorkflowID, ProjectID, SessionID, GoalID, RootTurnID, TemplateDigest string
	TemplateVersion, DefinitionRevision                                         int64
	SourceMessageID, SourceKind, SourceEventID                                  string
	Task                                                                        security.SecurityTask
	ResourceIDs                                                                 []string
	Resources                                                                   []security.ResourceRevision
	StepIDs                                                                     []string
	ChildScopeIDs                                                               map[string]string
}

type securityWorkflowRunRow struct {
	RunID                                                                                                                   string `gorm:"primaryKey"`
	StoreID, RecoveryEpoch, ProjectID, SessionID, WorkflowID, GoalID, TaskID, RootTurnID, TemplateDigest, RequestHash, Data string
	TemplateVersion, DefinitionRevision                                                                                     int64
	State                                                                                                                   string `gorm:"index"`
}

func (securityWorkflowRunRow) TableName() string { return "security_workflow_runs" }

// Claims a preauthorized first child scope for one real attempt; this stores
// neither operation results nor a copied grant budget.
type securityWorkflowChildScopeRow struct {
	RunID, StepID                                                               string `gorm:"primaryKey"`
	ScopeID, TaskID, AttemptID, SRETaskID, SREAttemptID, StoreID, RecoveryEpoch string
}

func (securityWorkflowChildScopeRow) TableName() string { return "security_workflow_child_scopes" }

func securityWorkflowModels() []any {
	return []any{&securityWorkflowDefinitionRow{}, &securityWorkflowRunRow{}, &securityWorkflowChildScopeRow{}}
}

func (e *Engine) SecurityProjectManaged(ctx context.Context, projectID string) (bool, error) {
	if err := e.CheckSecurityRuntime(); err != nil {
		return false, err
	}
	store, err := e.adkStore()
	if err != nil {
		return false, err
	}
	var count int64
	err = store.DB.WithContext(ctx).Model(&securityProjectPolicyRow{}).Where("project_id = ?", projectID).Count(&count).Error
	return count > 0, err
}

// SecurityWorkflowActionReference exposes only the original operation identity
// to the trusted Web bridge, never a serializable permit or self-reported actor.
func (e *Engine) SecurityWorkflowActionReference(ctx context.Context, projectID, sessionID string) (string, string, error) {
	if err := e.RequireSecurityBridgeContext(ctx, projectID, sessionID, "run_workflow"); err != nil {
		return "", "", err
	}
	permit, _ := ctx.Value(securityPermitContextKey{}).(*SecurityPermit)
	if permit == nil || permit.operation.Tool != "run_workflow" || permit.operation.ProjectID != projectID {
		return "", "", errSecurityAction
	}
	current, err := e.CurrentSecurityExecution(ctx, sessionID)
	if err != nil {
		return "", "", err
	}
	return permit.operation.ID, current.SourceMessageID, nil
}

func validateWorkflowDefinition(d SecurityWorkflowDefinition) error {
	if d.ProjectID == "" || d.WorkflowID == "" || d.TemplateVersion < 1 || len(d.TemplateDigest) != 64 || d.Goal == "" || len(d.Goal) > 1000 || len(d.Steps) < 1 || len(d.Steps) > 32 || len(d.Acceptance) != len(d.Steps) {
		return errSecurityAction
	}
	steps := map[string]SecurityWorkflowStep{}
	required := false
	for _, step := range d.Steps {
		if !identifier.MatchString(step.ID) || step.Title == "" || len(step.Title) > 4000 || len(step.ResourceIDs) > 1000 {
			return errSecurityAction
		}
		if _, exists := steps[step.ID]; exists {
			return errSecurityAction
		}
		steps[step.ID] = step
		contract, exists := d.Acceptance[step.ID]
		if !exists || security.ValidateCriteria(contract.Criteria) != nil {
			return errors.New("security: each workflow step needs explicit typed acceptance")
		}
		allowed := map[string]bool{}
		for _, id := range step.ResourceIDs {
			allowed[id] = true
		}
		for _, criterion := range contract.Criteria {
			if criterion.Method == "operation_succeeded" || !allowed[criterion.Target] {
				return errors.New("security: workflow needs business acceptance bound to its explicit resources")
			}
		}
		required = required || contract.Required
	}
	if !required {
		return errors.New("security: workflow must retain required acceptance")
	}
	visiting, visited := map[string]bool{}, map[string]bool{}
	var visit func(string) bool
	visit = func(id string) bool {
		if visiting[id] {
			return false
		}
		if visited[id] {
			return true
		}
		step, ok := steps[id]
		if !ok {
			return false
		}
		visiting[id] = true
		for _, dep := range step.DependsOn {
			if !visit(dep) {
				return false
			}
		}
		visiting[id] = false
		visited[id] = true
		return true
	}
	for id := range steps {
		if !visit(id) {
			return errors.New("security: workflow dependency cycle or missing prerequisite")
		}
	}
	return nil
}

func (e *Engine) PutSecurityWorkflowDefinition(ctx context.Context, a SecurityWorkflowDefinitionAction, d SecurityWorkflowDefinition) (out SecurityWorkflowDefinition, err error) {
	if a.ActorID == "" || a.ActionID == "" || a.ExpectedRevision < 0 || a.ProjectID != d.ProjectID || a.WorkflowID != d.WorkflowID {
		return out, errSecurityAction
	}
	if err = validateWorkflowDefinition(d); err != nil {
		return out, err
	}
	encoded, err := json.Marshal(d)
	if err != nil {
		return out, err
	}
	d = SecurityWorkflowDefinition{}
	if err = json.Unmarshal(encoded, &d); err != nil {
		return out, err
	}
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return out, err
	}
	request := js(struct {
		Action     SecurityWorkflowDefinitionAction
		Definition SecurityWorkflowDefinition
	}{a, d})
	err = db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if ok, err := securityActionReplay(tx, storeID, epoch, a.ActorID, a.ActionID, request, &out); ok || err != nil {
			return err
		}
		var prior securityWorkflowDefinitionRow
		err := tx.First(&prior, "project_id = ? AND workflow_id = ?", a.ProjectID, a.WorkflowID).Error
		if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		if prior.Revision != a.ExpectedRevision {
			return security.ErrConflict
		}
		d.Revision = prior.Revision + 1
		for id, contract := range d.Acceptance {
			contract.Revision = d.Revision
			d.Acceptance[id] = contract
		}
		row := securityWorkflowDefinitionRow{ProjectID: d.ProjectID, WorkflowID: d.WorkflowID, StoreID: storeID, RecoveryEpoch: epoch, TemplateVersion: d.TemplateVersion, TemplateDigest: d.TemplateDigest, Revision: d.Revision, Data: js(d)}
		if prior.Revision == 0 {
			err = tx.Create(&row).Error
		} else {
			updated := tx.Model(&securityWorkflowDefinitionRow{}).Where("project_id = ? AND workflow_id = ? AND revision = ?", a.ProjectID, a.WorkflowID, prior.Revision).Select("*").Updates(&row)
			err = updated.Error
			if err == nil && updated.RowsAffected != 1 {
				err = security.ErrConflict
			}
		}
		if err != nil {
			return err
		}
		out = d
		return securityActionRecord(tx, storeID, epoch, a.ActorID, a.ActionID, "workflow.definition", a.WorkflowID, request, prior.Revision, d.Revision, d, time.Now().UTC())
	})
	return out, err
}

func LoadSecurityWorkflowDefinitionTx(tx *gorm.DB, storeID, epoch, projectID, workflowID string, version int64, digest string) (SecurityWorkflowDefinition, error) {
	var row securityWorkflowDefinitionRow
	if err := tx.First(&row, "project_id = ? AND workflow_id = ?", projectID, workflowID).Error; err != nil {
		return SecurityWorkflowDefinition{}, errors.New("security: workflow acceptance contract must be confirmed before running")
	}
	if row.StoreID != storeID || row.RecoveryEpoch != epoch || row.TemplateVersion != version || row.TemplateDigest != digest {
		return SecurityWorkflowDefinition{}, errors.New("security: workflow template or recovery identity changed; confirm its contract again")
	}
	var definition SecurityWorkflowDefinition
	if err := json.Unmarshal([]byte(row.Data), &definition); err != nil {
		return definition, err
	}
	if definition.Revision != row.Revision || definition.TemplateDigest != digest || definition.TemplateVersion != version || definition.ProjectID != projectID || definition.WorkflowID != workflowID {
		return definition, security.ErrConflict
	}
	return definition, validateWorkflowDefinition(definition)
}

func (e *Engine) SecurityWorkflowDefinition(ctx context.Context, projectID, workflowID string, version int64, digest string) (SecurityWorkflowDefinition, error) {
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return SecurityWorkflowDefinition{}, err
	}
	return LoadSecurityWorkflowDefinitionTx(db.WithContext(ctx), storeID, epoch, projectID, workflowID, version, digest)
}

// CreateSecurityWorkflowRunTx creates only durable application records. The
// scheduler may consume an occurrence and issue its task grant in this same
// transaction. No Web run, owner, model or external I/O starts before commit.
func CreateSecurityWorkflowRunTx(tx *gorm.DB, storeID, epoch string, in SecurityWorkflowRunInput, now time.Time) (SecurityWorkflowRunBinding, error) {
	var out SecurityWorkflowRunBinding
	if !identifier.MatchString(in.RunID) || !identifier.MatchString(in.SessionID) || in.ProjectID == "" || in.WorkflowID == "" || in.ActorID == "" || in.ActionID == "" || in.SourceEventID == "" || now.IsZero() {
		return out, errSecurityAction
	}
	if in.SourceKind != "workflow_run" && in.SourceKind != "schedule_occurrence" {
		return out, errSecurityAction
	}
	requestHash := hash(js(in))
	var existing securityWorkflowRunRow
	err := tx.First(&existing, "run_id = ?", in.RunID).Error
	if err == nil {
		if existing.RequestHash != requestHash || existing.StoreID != storeID || existing.RecoveryEpoch != epoch {
			return out, security.ErrConflict
		}
		err = json.Unmarshal([]byte(existing.Data), &out)
		return out, err
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return out, err
	}
	definition, err := LoadSecurityWorkflowDefinitionTx(tx, storeID, epoch, in.ProjectID, in.WorkflowID, in.TemplateVersion, in.TemplateDigest)
	if err != nil {
		return out, err
	}
	for _, contract := range definition.Acceptance {
		for _, criterion := range contract.Criteria {
			var resource securityResourceRevisionRow
			if err = tx.First(&resource, "project_id = ? AND resource_id = ?", in.ProjectID, criterion.Target).Error; err != nil {
				return out, err
			}
			if resource.StoreID != storeID || resource.RecoveryEpoch != epoch || resource.State != "ready" || resource.ConnectionRevision != criterion.ConnectionRevision {
				return out, errors.New("security: workflow acceptance resource changed")
			}
		}
	}
	policy, err := loadSecurityPolicy(tx, in.ProjectID, storeID, epoch)
	if err != nil {
		return out, err
	}
	for _, rule := range policy.Rules {
		if rule.Capability == "workflow.run" && rule.Effect == security.EffectDeny {
			return out, errors.New("security: workflow execution denied by project policy")
		}
	}
	goalID, rootTurnID := hash("workflow-goal\x00"+in.RunID), hash("workflow-root\x00"+in.RunID)
	goal := WorkGoal{ID: goalID, SessionID: in.SessionID, OriginRootTurnID: rootTurnID, UserText: definition.Goal, Title: definition.Goal, Status: "running", RoundLimit: 500, DeadlineAt: now.Add(security.MaxTaskLifetime), UpdatedAt: now}
	contract := WorkClosureContract{ProjectID: in.ProjectID, GoalRevision: 1, PlanRevision: 1, Steps: map[string]WorkStepContract{}, ActiveAttempts: map[string]string{}}
	resources := map[string]bool{}
	out.ChildScopeIDs = map[string]string{}
	for _, step := range definition.Steps {
		goal.Items = append(goal.Items, WorkItem{ID: step.ID, Title: step.Title, Status: "pending", DependsOn: append([]string(nil), step.DependsOn...)})
		c := definition.Acceptance[step.ID]
		c.Revision = 1
		contract.Steps[step.ID] = c
		out.StepIDs = append(out.StepIDs, step.ID)
		out.ChildScopeIDs[step.ID] = hash("workflow-child\x00" + in.RunID + "\x00" + step.ID)[:32]
		for _, id := range step.ResourceIDs {
			resources[id] = true
		}
	}
	goal.closure = &contract
	row := nativeWorkGoal{ID: goalID, SessionID: in.SessionID, RootTurnID: rootTurnID, OriginMessageID: in.SourceMessageID}
	if err = writeWorkGoalTx(tx, &row, &goal, true); err != nil {
		return out, err
	}
	if err = tx.Create(&workContractRevision{ID: hash("workflow-contract\x00" + in.RunID), SessionID: in.SessionID, ActionID: "workflow-contract:" + in.RunID, GoalID: goalID, GoalRevision: 1, PlanRevision: 1, Actor: in.ActorID, RequestHash: hash(js(contract)), Data: js(contract), At: now}).Error; err != nil {
		return out, err
	}
	kind := "workflow"
	if in.SourceKind == "schedule_occurrence" {
		kind = "schedule"
	}
	task, err := beginSecurityTask(tx, storeID, epoch, SecurityTaskStart{Action: SecurityTaskAction{ActorID: in.ActorID, ActionID: in.ActionID, ProjectID: in.ProjectID, SessionID: in.SessionID, GoalID: goalID}, Kind: kind, SourceMessageID: in.SourceMessageID, SourceKind: in.SourceKind, SourceEventID: in.SourceEventID, ExpectedGoalRevision: 1, ExpiresAt: in.ExpiresAt}, now)
	if err != nil {
		return out, err
	}
	if _, err = bindSecurityTaskTurn(tx, task.ID, storeID, epoch, rootTurnID, "", task.ExecutionRevision, now); err != nil {
		return out, err
	}
	for id := range resources {
		out.ResourceIDs = append(out.ResourceIDs, id)
	}
	sort.Strings(out.ResourceIDs)
	for _, id := range out.ResourceIDs {
		permitted := false
		for _, allowed := range policy.ResourceIDs {
			if allowed == id {
				permitted = true
			}
		}
		if !permitted {
			return out, errors.New("security: workflow resource outside project ceiling")
		}
		var resource securityResourceRevisionRow
		if err = tx.First(&resource, "project_id = ? AND resource_id = ?", in.ProjectID, id).Error; err != nil {
			return out, err
		}
		if resource.StoreID != storeID || resource.RecoveryEpoch != epoch || resource.State != "ready" || policy.DenyLocal && resource.Local {
			return out, errors.New("security: workflow resource is not currently dispatchable")
		}
		out.Resources = append(out.Resources, security.ResourceRevision{ID: id, ConnectionRevision: resource.ConnectionRevision, ConnectionDigest: resource.ConnectionDigest, ConnectionIdentity: resource.ConnectionIdentity, State: resource.State, Local: resource.Local})
	}
	if err = tx.Create(&securityBoundaryRow{ID: uid(), ProjectID: in.ProjectID, SessionID: in.SessionID, TaskID: task.ID, OwnerKind: "task", Provenance: "workflow_template", SourceActionID: in.ActionID, StoreID: storeID, RecoveryEpoch: epoch, Revision: 1, ResourceIDs: js(out.ResourceIDs), RestrictResources: true}).Error; err != nil {
		return out, err
	}
	out.RunID, out.WorkflowID, out.ProjectID, out.SessionID, out.GoalID, out.RootTurnID, out.TemplateDigest = in.RunID, in.WorkflowID, in.ProjectID, in.SessionID, goalID, rootTurnID, in.TemplateDigest
	out.TemplateVersion, out.DefinitionRevision, out.SourceKind, out.SourceEventID, out.SourceMessageID, out.Task = in.TemplateVersion, definition.Revision, in.SourceKind, in.SourceEventID, in.SourceMessageID, task
	if err = tx.Create(&securityWorkflowRunRow{RunID: in.RunID, StoreID: storeID, RecoveryEpoch: epoch, ProjectID: in.ProjectID, SessionID: in.SessionID, WorkflowID: in.WorkflowID, GoalID: goalID, TaskID: task.ID, RootTurnID: rootTurnID, TemplateDigest: in.TemplateDigest, TemplateVersion: in.TemplateVersion, DefinitionRevision: definition.Revision, RequestHash: requestHash, Data: js(out), State: "prepared"}).Error; err != nil {
		return out, err
	}
	return out, nil
}

func (e *Engine) BeginSecurityWorkflowRun(ctx context.Context, in SecurityWorkflowRunInput) (out SecurityWorkflowRunBinding, err error) {
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return out, err
	}
	err = db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		out, err = CreateSecurityWorkflowRunTx(tx, storeID, epoch, in, time.Now().UTC())
		return err
	})
	return out, err
}

// Future scopes come only from an immutable registered run and its confirmed
// definition. Arbitrary strings and prefixes never imply child delegation.
func securityTaskAllowsFutureChildScope(tx *gorm.DB, taskID, scopeID, storeID, epoch string) (bool, error) {
	var row securityWorkflowRunRow
	err := tx.First(&row, "task_id = ? AND store_id = ? AND recovery_epoch = ? AND state IN ?", taskID, storeID, epoch, []string{"prepared", "running"}).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	var binding SecurityWorkflowRunBinding
	if err = json.Unmarshal([]byte(row.Data), &binding); err != nil {
		return false, err
	}
	definition, err := LoadSecurityWorkflowDefinitionTx(tx, storeID, epoch, row.ProjectID, row.WorkflowID, row.TemplateVersion, row.TemplateDigest)
	if err != nil {
		return false, err
	}
	if binding.RunID != row.RunID || binding.Task.ID != taskID || binding.Task.StoreID != storeID || binding.Task.RecoveryEpoch != epoch || binding.ProjectID != row.ProjectID || binding.SessionID != row.SessionID || binding.GoalID != row.GoalID || binding.DefinitionRevision != row.DefinitionRevision || definition.Revision != row.DefinitionRevision || len(binding.ChildScopeIDs) != len(definition.Steps) {
		return false, security.ErrConflict
	}
	matched := false
	for _, step := range definition.Steps {
		want := hash("workflow-child\x00" + row.RunID + "\x00" + step.ID)[:32]
		if binding.ChildScopeIDs[step.ID] != want {
			return false, security.ErrConflict
		}
		matched = matched || want == scopeID
	}
	return matched, nil
}

func (e *Engine) claimSecurityWorkflowChildScope(ctx context.Context, execution SecurityExecutionContext, sreTaskID, sreAttemptID string) (scope string, err error) {
	if !execution.Managed || execution.AttemptID == "" {
		return "", nil
	}
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return "", err
	}
	err = db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := ValidateExecutionOwner(tx, execution.Owner, time.Now().UTC()); err != nil {
			return err
		}
		var actual securitySREAttemptBinding
		if err := tx.First(&actual, "session_id = ? AND sre_task_id = ? AND sre_attempt_id = ? AND task_id = ? AND step_id = ? AND attempt_id = ? AND root_turn_id = ? AND store_id = ? AND recovery_epoch = ?", execution.SessionID, sreTaskID, sreAttemptID, execution.Task.ID, execution.StepID, execution.AttemptID, execution.Owner.RootTurnID, storeID, epoch).Error; err != nil {
			return err
		}
		var run securityWorkflowRunRow
		err := tx.First(&run, "task_id = ? AND state = ?", execution.Task.ID, "running").Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil
		}
		if err != nil {
			return err
		}
		var binding SecurityWorkflowRunBinding
		if err = json.Unmarshal([]byte(run.Data), &binding); err != nil {
			return err
		}
		candidate := binding.ChildScopeIDs[execution.StepID]
		allowed, err := securityTaskAllowsFutureChildScope(tx, execution.Task.ID, candidate, storeID, epoch)
		if err != nil {
			return err
		}
		if !allowed {
			return security.ErrConflict
		}
		var prior securityWorkflowChildScopeRow
		err = tx.First(&prior, "run_id = ? AND step_id = ?", run.RunID, execution.StepID).Error
		if err == nil {
			if prior.StoreID != storeID || prior.RecoveryEpoch != epoch || prior.TaskID != execution.Task.ID {
				return security.ErrConflict
			}
			if prior.AttemptID == execution.AttemptID && prior.SRETaskID == sreTaskID && prior.SREAttemptID == sreAttemptID {
				scope = prior.ScopeID
			}
			return nil // A retry receives a new scope; old delegation is never copied.
		}
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		row := securityWorkflowChildScopeRow{RunID: run.RunID, StepID: execution.StepID, ScopeID: candidate, TaskID: execution.Task.ID, AttemptID: execution.AttemptID, SRETaskID: sreTaskID, SREAttemptID: sreAttemptID, StoreID: storeID, RecoveryEpoch: epoch}
		if err = tx.Create(&row).Error; err != nil {
			return err
		}
		scope = candidate
		return nil
	})
	return scope, err
}

func (e *Engine) ActivateSecurityWorkflowRun(ctx context.Context, runID string) (out SecurityExecutionContext, err error) {
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return out, err
	}
	var binding SecurityWorkflowRunBinding
	err = db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var row securityWorkflowRunRow
		if err := tx.First(&row, "run_id = ? AND store_id = ? AND recovery_epoch = ?", runID, storeID, epoch).Error; err != nil {
			return err
		}
		if row.State != "prepared" {
			return errors.New("security: workflow run already admitted or needs reconciliation")
		}
		if err := json.Unmarshal([]byte(row.Data), &binding); err != nil {
			return err
		}
		task, err := verifySecurityTaskTx(tx, binding.Task.ID, binding.SessionID, binding.GoalID, binding.RootTurnID, time.Now().UTC())
		if err != nil {
			return err
		}
		var turn securityTaskBinding
		if err = tx.First(&turn, "task_id = ? AND root_turn_id = ? AND scope_id = '' AND state = ?", task.ID, binding.RootTurnID, "active").Error; err != nil {
			return err
		}
		owner, err := acquireExecutionOwner(tx, turn.ID, uid(), "agent", turn.OwnerGeneration, time.Now().UTC())
		if err != nil {
			return err
		}
		updated := tx.Model(&securityWorkflowRunRow{}).Where("run_id = ? AND state = ?", runID, "prepared").Update("state", "running")
		if updated.Error != nil {
			return updated.Error
		}
		if updated.RowsAffected != 1 {
			return security.ErrConflict
		}
		out = SecurityExecutionContext{Managed: true, ProjectID: binding.ProjectID, SessionID: binding.SessionID, GoalID: binding.GoalID, SourceMessageID: binding.SourceMessageID, Task: task, Owner: owner, FrozenResources: binding.Resources}
		return nil
	})
	if err != nil {
		return out, err
	}
	s, err := e.get(binding.SessionID)
	if err != nil {
		return out, err
	}
	s.mu.Lock()
	s.state.SecurityManaged = true
	s.state.SelectedGoalID, s.state.WorkGoalID, s.state.SecurityTaskID, s.state.SecuritySourceMessageID = binding.GoalID, binding.GoalID, binding.Task.ID, binding.SourceMessageID
	s.state.View.RootTurnID = binding.RootTurnID
	s.state.Config.securityExecution = nil
	err = e.save(s)
	s.mu.Unlock()
	if err != nil {
		return out, err
	}
	e.securityOwnerEngine().securityOwners.Store(out.Owner.BindingID, &liveSecurityOwner{owner: out.Owner})
	e.securityOwnerEngine().startSecurityLifecycle()
	return out, nil
}
