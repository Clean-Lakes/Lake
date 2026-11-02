package ai

import (
	"context"
	"errors"
	"time"

	"github.com/Clean-Lakes/Lake/internal/security"
	"gorm.io/gorm"
)

type securitySREPlanBinding struct {
	SessionID                                                  string `gorm:"primaryKey"`
	SRETaskID                                                  string `gorm:"primaryKey"`
	RootTurnID                                                 string `gorm:"primaryKey"`
	StoreID, RecoveryEpoch, GoalID, TaskID, PlanID, PlanDigest string
	GoalRevision, PlanRevision                                 int64
}

func (securitySREPlanBinding) TableName() string { return "security_sre_plan_bindings" }

type securitySREAttemptBinding struct {
	SessionID                                                          string `gorm:"primaryKey"`
	SRETaskID                                                          string `gorm:"primaryKey"`
	SREAttemptID                                                       string `gorm:"primaryKey"`
	StoreID, RecoveryEpoch, GoalID, StepID, TaskID, RootTurnID, PlanID string
	AttemptID                                                          string `gorm:"uniqueIndex"`
}

func (securitySREAttemptBinding) TableName() string { return "security_sre_attempt_bindings" }

func securitySREModels() []any { return []any{&securitySREPlanBinding{}, &securitySREAttemptBinding{}} }

func (e *Engine) prepareSecuritySREStart(ctx context.Context, s *session, task SRETask) (SecurityExecutionContext, error) {
	current, err := e.CurrentSecurityExecution(ctx, task.SessionID)
	if err == nil && current.Managed && current.Task.ID != "" {
		return current, nil
	}
	db, _, _, dbErr := e.securityTaskDB()
	if dbErr != nil {
		return current, dbErr
	}
	var selection securityGoalSelectionRow
	if dbErr = db.WithContext(ctx).First(&selection, "session_id = ?", task.SessionID).Error; dbErr != nil || selection.GoalID == "" || selection.SourceMessageID == "" {
		return current, errors.New("security: select and confirm the work goal before SRE execution")
	}
	_, goal, dbErr := e.workRow(task.SessionID, selection.GoalID)
	if dbErr != nil {
		return current, dbErr
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cancel != nil {
		return current, errors.New("security: session is busy")
	}
	c := s.state.Config
	root := uid()
	prepared, err := e.prepareSecurityTurnLocked(ctx, s, &c, TurnInput{UserText: goal.UserText, SecurityGoalID: goal.ID, SecurityGoalRevision: selection.GoalRevision}, selection.SourceMessageID, root)
	if err != nil {
		return prepared, err
	}
	if !prepared.Managed || prepared.Task.ID == "" {
		return prepared, errors.New("security: managed execution task required")
	}
	s.state.View.RootTurnID = root
	if err = e.save(s); err != nil {
		return prepared, err
	}
	return prepared, nil
}

// BindSecuritySREPlan maps the real, immutable SRE plan into an already approved
// WorkGoal. It neither duplicates SRE operations nor grants their capabilities.
func (e *Engine) BindSecuritySREPlan(ctx context.Context, sessionID, sreTaskID string) error {
	execution, err := e.CurrentSecurityExecution(ctx, sessionID)
	if err != nil {
		return err
	}
	if !execution.Managed {
		return nil
	}
	if e.sreRepository == nil {
		return errors.New("security: SRE repository unavailable")
	}
	task, err := e.sreRepository.LoadSRETask(sessionID, sreTaskID)
	if err != nil {
		return err
	}
	plan := task.LatestPlan()
	if plan == nil {
		return errors.New("security: immutable SRE plan required")
	}
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return err
	}
	return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := ValidateExecutionOwner(tx, execution.Owner, time.Now().UTC()); err != nil {
			return err
		}
		var row nativeWorkGoal
		if err := tx.First(&row, "id = ? AND session_id = ?", execution.GoalID, sessionID).Error; err != nil {
			return err
		}
		var goal WorkGoal
		if err := decodeWorkGoal(row, &goal); err != nil {
			return err
		}
		if goal.closure == nil || goal.closure.ProjectID != task.ProjectID || task.ProjectID != execution.ProjectID {
			return security.ErrConflict
		}
		var workflow securityWorkflowRunRow
		workflowErr := tx.First(&workflow, "session_id = ? AND goal_id = ? AND state = ?", sessionID, goal.ID, "running").Error
		if workflowErr == nil {
			definition, err := LoadSecurityWorkflowDefinitionTx(tx, storeID, epoch, workflow.ProjectID, workflow.WorkflowID, workflow.TemplateVersion, workflow.TemplateDigest)
			if err != nil {
				return err
			}
			if definition.Revision != workflow.DefinitionRevision || len(plan.Steps) != len(definition.Steps) || plan.Goal != definition.Goal {
				return security.ErrConflict
			}
			for _, actual := range plan.Steps {
				matched := false
				for _, expected := range definition.Steps {
					if actual.ID == expected.ID && actual.Description == expected.Title && string(actual.Role) == expected.Role && sameSREIDs(actual.ResourceIDs, expected.ResourceIDs) && sameSREIDs(actual.DependsOn, expected.DependsOn) {
						matched = true
					}
				}
				if !matched {
					return errors.New("security: SRE role or target differs from confirmed workflow")
				}
			}
		} else if !errors.Is(workflowErr, gorm.ErrRecordNotFound) {
			return workflowErr
		}
		allowed := map[string]bool{}
		for _, binding := range goal.ResourceBindings {
			allowed[binding.AssetRef] = true
		}
		if goal.Binding.AssetRef != "" {
			allowed[goal.Binding.AssetRef] = true
		}
		for _, contract := range goal.closure.Steps {
			for _, criterion := range contract.Criteria {
				allowed[criterion.Target] = true
			}
		}
		for _, step := range plan.Steps {
			if _, ok := goal.closure.Steps[step.ID]; !ok {
				return errors.New("security: SRE step has no confirmed goal contract")
			}
			matched := false
			for _, item := range goal.Items {
				if item.ID == step.ID && item.Title == step.Description {
					matched = true
					if !sameSREIDs(item.DependsOn, step.DependsOn) {
						return security.ErrConflict
					}
				}
			}
			if !matched {
				return errors.New("security: SRE step definition requires confirmation")
			}
			for _, id := range step.ResourceIDs {
				if !allowed[id] {
					return errors.New("security: SRE resource was not in the confirmed work scope")
				}
			}
		}
		binding := securitySREPlanBinding{SessionID: sessionID, SRETaskID: sreTaskID, StoreID: storeID, RecoveryEpoch: epoch, GoalID: goal.ID, TaskID: execution.Task.ID, RootTurnID: execution.Owner.RootTurnID, PlanID: plan.ID, PlanDigest: hash(js(plan)), GoalRevision: goal.closure.GoalRevision, PlanRevision: goal.closure.PlanRevision}
		var old securitySREPlanBinding
		err := tx.First(&old, "session_id = ? AND sre_task_id = ? AND root_turn_id = ?", sessionID, sreTaskID, execution.Owner.RootTurnID).Error
		if err == nil {
			if old != binding {
				return security.ErrConflict
			}
			return nil
		}
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		if err = tx.Create(&binding).Error; err != nil {
			return err
		}
		key := hash(storeID + "\x00" + epoch + "\x00sre-plan\x00" + sessionID + "\x00" + sreTaskID + "\x00" + execution.Owner.RootTurnID)
		return tx.Create(&securityAuthorityEvent{ID: uid(), ProjectID: execution.ProjectID, ActionKey: key, RequestHash: hash(js(binding)), StoreID: storeID, RecoveryEpoch: epoch, ActorID: "runtime", ActionID: key, Kind: "sre.plan_binding", ObjectID: sreTaskID, AfterRevision: 1, Result: js(binding), At: time.Now().UTC()}).Error
	})
}

func (e *Engine) prepareSecuritySRERole(ctx context.Context, sessionID string, task SRETask, step SREPlanStep, attemptID string, noTools bool) (SecurityExecutionContext, error) {
	current, err := e.CurrentSecurityExecution(ctx, sessionID)
	if !current.Managed {
		return current, err
	}
	if noTools && attemptID == "" {
		return SecurityExecutionContext{Managed: true, ProjectID: current.ProjectID, SessionID: sessionID}, nil
	}
	if err != nil {
		return current, err
	}
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return current, err
	}
	var binding securitySREPlanBinding
	if err = db.WithContext(ctx).First(&binding, "session_id = ? AND sre_task_id = ? AND root_turn_id = ?", sessionID, task.ID, current.Owner.RootTurnID).Error; err != nil {
		return current, errors.New("security: SRE plan must be associated with the confirmed work goal")
	}
	plan := task.LatestPlan()
	if plan == nil || binding.StoreID != storeID || binding.RecoveryEpoch != epoch || binding.PlanID != plan.ID || binding.PlanDigest != hash(js(plan)) || binding.TaskID != current.Task.ID || binding.GoalID != current.GoalID || binding.RootTurnID != current.Owner.RootTurnID || binding.GoalRevision != current.GoalRevision || binding.PlanRevision != current.PlanRevision {
		return current, security.ErrConflict
	}
	if noTools {
		presentationOnly, err := e.securitySREPresentationOnly(ctx, sessionID, task, step)
		if err != nil {
			return current, err
		}
		if presentationOnly {
			return SecurityExecutionContext{Managed: true, ProjectID: current.ProjectID, SessionID: sessionID}, nil
		}
	}
	if attemptID == "" {
		return current, errors.New("security: original SRE attempt required")
	}
	var mapped securitySREAttemptBinding
	err = db.WithContext(ctx).First(&mapped, "session_id = ? AND sre_task_id = ? AND sre_attempt_id = ?", sessionID, task.ID, attemptID).Error
	if err == nil {
		if mapped.StoreID != storeID || mapped.RecoveryEpoch != epoch || mapped.GoalID != current.GoalID || mapped.StepID != step.ID || mapped.TaskID != current.Task.ID || mapped.RootTurnID != current.Owner.RootTurnID || mapped.PlanID != plan.ID {
			return current, security.ErrConflict
		}
		return e.securityExecutionForStep(ctx, current, step.ID, mapped.AttemptID)
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return current, err
	}
	row, goal, err := e.workRow(sessionID, current.GoalID)
	if err != nil {
		return current, err
	}
	if goal.closure == nil || goal.closure.GoalRevision != binding.GoalRevision || goal.closure.PlanRevision != binding.PlanRevision {
		return current, security.ErrConflict
	}
	workAttempt := goal.closure.ActiveAttempts[step.ID]
	if workAttempt == "" {
		for casTry := 0; casTry < 4; casTry++ {
			workAttempt, err = e.BeginWorkAttempt(sessionID, goal.ID, step.ID, current.Task.ID, current.Owner.RootTurnID, "", "SRE attempt "+attemptID, row.Revision)
			if err == nil {
				break
			}
			if !errors.Is(err, errWorkConflict) {
				return current, err
			}
			row, goal, err = e.workRow(sessionID, current.GoalID)
			if err != nil {
				return current, err
			}
			if goal.closure == nil || goal.closure.GoalRevision != binding.GoalRevision || goal.closure.PlanRevision != binding.PlanRevision || goal.closure.ActiveAttempts[step.ID] != "" {
				return current, security.ErrConflict
			}
		}
		if workAttempt == "" || err != nil {
			return current, errWorkConflict
		}
	} else {
		var attempt workExecutionAttempt
		if err = db.WithContext(ctx).First(&attempt, "id = ? AND session_id = ? AND goal_id = ? AND step_id = ? AND security_task_id = ? AND root_turn_id = ?", workAttempt, sessionID, goal.ID, step.ID, current.Task.ID, current.Owner.RootTurnID).Error; err != nil {
			return current, errors.New("security: a new retry must be explicitly associated with this run")
		}
		var used int64
		if err = db.WithContext(ctx).Model(&securitySREAttemptBinding{}).Where("attempt_id = ?", workAttempt).Count(&used).Error; err != nil {
			return current, err
		}
		if used != 0 || attempt.State != "prepared" {
			return current, errors.New("security: previous SRE attempt cannot be silently retried")
		}
	}
	mapped = securitySREAttemptBinding{SessionID: sessionID, SRETaskID: task.ID, SREAttemptID: attemptID, StoreID: storeID, RecoveryEpoch: epoch, GoalID: goal.ID, StepID: step.ID, AttemptID: workAttempt, TaskID: current.Task.ID, RootTurnID: current.Owner.RootTurnID, PlanID: plan.ID}
	if err = db.WithContext(ctx).Create(&mapped).Error; err != nil {
		return current, err
	}
	return e.securityExecutionForStep(ctx, current, step.ID, workAttempt)
}

func (e *Engine) securityExecutionForStep(ctx context.Context, base SecurityExecutionContext, stepID, attemptID string) (SecurityExecutionContext, error) {
	db, _, _, err := e.securityTaskDB()
	if err != nil {
		return base, err
	}
	_, goal, err := e.workRow(base.SessionID, base.GoalID)
	if err != nil {
		return base, err
	}
	if goal.closure == nil {
		return base, security.ErrConflict
	}
	base.StepID, base.AttemptID = stepID, attemptID
	base.GoalRevision, base.PlanRevision, base.StepRevision = goal.closure.GoalRevision, goal.closure.PlanRevision, goal.closure.Steps[stepID].Revision
	ready, err := securityCanonicalStepReady(db.WithContext(ctx), securityStepDescriptor(base), false)
	if err != nil {
		return base, err
	}
	if !ready {
		return base, security.ErrConflict
	}
	if base.Owner, err = refreshExecutionOwnerLease(db.WithContext(ctx), base.Owner, time.Now().UTC()); err != nil {
		return base, err
	}
	return base, nil
}

// A template's optional final summary is pure presentation. It remains in the
// original SRE report/state, but has neither resource tools nor a fabricated
// execution/acceptance record. Required business steps can never use this path.
func (e *Engine) securitySREPresentationOnly(ctx context.Context, sessionID string, task SRETask, step SREPlanStep) (bool, error) {
	if step.Role != SRECoordinator || step.Kind != "summarize" {
		return false, nil
	}
	execution, err := e.CurrentSecurityExecution(ctx, sessionID)
	if !execution.Managed {
		return false, err
	}
	if err != nil {
		return false, err
	}
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return false, err
	}
	var run securityWorkflowRunRow
	err = db.WithContext(ctx).First(&run, "task_id = ? AND session_id = ? AND state = ?", execution.Task.ID, sessionID, "running").Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	definition, err := LoadSecurityWorkflowDefinitionTx(db.WithContext(ctx), storeID, epoch, run.ProjectID, run.WorkflowID, run.TemplateVersion, run.TemplateDigest)
	if err != nil {
		return false, err
	}
	if definition.Revision != run.DefinitionRevision {
		return false, security.ErrConflict
	}
	_, goal, err := e.workRow(sessionID, execution.GoalID)
	if err != nil {
		return false, err
	}
	contract, ok := goal.closure.Steps[step.ID]
	if !ok || contract.Required {
		return false, nil
	}
	for _, expected := range definition.Steps {
		if expected.ID == step.ID && expected.Role == string(step.Role) && expected.Title == step.Description && sameSREIDs(expected.ResourceIDs, step.ResourceIDs) && sameSREIDs(expected.DependsOn, step.DependsOn) {
			return true, nil
		}
	}
	return false, security.ErrConflict
}

func (e *Engine) verifySecuritySRERole(execution SecurityExecutionContext, step SREPlanStep) error {
	if !execution.Managed || execution.Task.ID == "" || execution.StepID == "" {
		return nil
	}
	row, goal, err := e.workRow(execution.SessionID, execution.GoalID)
	if err != nil {
		return err
	}
	id, err := e.VerifyWorkStep(execution.SessionID, execution.GoalID, execution.StepID, row.Revision)
	if err != nil {
		return err
	}
	store, err := e.adkStore()
	if err != nil {
		return err
	}
	var result workAcceptanceRecord
	if err = store.DB.First(&result, "id = ? AND goal_id = ? AND step_id = ?", id, execution.GoalID, execution.StepID).Error; err != nil {
		return err
	}
	if goal.closure.Steps[execution.StepID].Required && result.State != string(security.AcceptancePass) {
		return errors.New("security: SRE execution finished but required step acceptance is incomplete")
	}
	return nil
}
