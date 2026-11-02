package ai

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/Clean-Lakes/Lake/internal/security"
	"gorm.io/gorm"
)

type SecurityExecutionContext struct {
	Managed                                                          bool
	ProjectID, SessionID, GoalID, StepID, AttemptID, SourceMessageID string
	Task                                                             security.SecurityTask
	Owner                                                            ExecutionOwner
	GoalRevision, PlanRevision, StepRevision                         int64
	FrozenResources                                                  []security.ResourceRevision
}

type liveSecurityOwner struct {
	mu    sync.Mutex
	owner ExecutionOwner
}

type securityGoalSelectionRow struct {
	SessionID                                                  string `gorm:"primaryKey"`
	ProjectID, StoreID, RecoveryEpoch, GoalID, SourceMessageID string
	GoalRevision, Revision                                     int64
	NewGoal                                                    bool
}

func (securityGoalSelectionRow) TableName() string { return "security_goal_selections" }

type SecurityGoalSelection struct {
	ActorID, ActionID, ProjectID, SessionID, GoalID, SourceMessageID string
	ExpectedGoalRevision, ExpectedRevision                           int64
	NewGoal                                                          bool
}

func configSecurityProject(c Config) string {
	if c.SecurityProjectID != "" {
		return c.SecurityProjectID
	}
	return c.MemoryProjectID // Compatibility with existing trusted Web host config.
}

func (e *Engine) SelectSecurityGoal(ctx context.Context, in SecurityGoalSelection) error {
	if in.ActorID == "" || in.ActionID == "" || in.SourceMessageID == "" || in.ProjectID == "" || in.SessionID == "" || in.ExpectedRevision < 0 || in.NewGoal && (in.GoalID != "" || in.ExpectedGoalRevision != 0) || !in.NewGoal && (in.GoalID == "" || in.ExpectedGoalRevision < 1) {
		return errSecurityAction
	}
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return err
	}
	var result securityGoalSelectionRow
	request := js(in)
	err = db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if ok, err := securityActionReplay(tx, storeID, epoch, in.ActorID, in.ActionID, request, &result); ok || err != nil {
			return err
		}
		var row securityGoalSelectionRow
		err := tx.First(&row, "session_id = ?", in.SessionID).Error
		if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		if row.Revision != in.ExpectedRevision || row.SessionID != "" && row.ProjectID != in.ProjectID {
			return security.ErrConflict
		}
		if !in.NewGoal {
			var goal nativeWorkGoal
			if err = tx.First(&goal, "id = ? AND session_id = ?", in.GoalID, in.SessionID).Error; err != nil {
				return err
			}
			var contract WorkClosureContract
			if workTerminal(goal.Status) || goal.GoalRevision != in.ExpectedGoalRevision || json.Unmarshal([]byte(goal.ClosureContract), &contract) != nil || contract.ProjectID != in.ProjectID {
				return security.ErrConflict
			}
		}
		// Changing selection invalidates the old foreground execution context;
		// the original goal and all operation/attempt evidence remain intact.
		if row.GoalID != "" && row.GoalID != in.GoalID {
			var oldRow nativeWorkGoal
			if err = tx.First(&oldRow, "id = ? AND session_id = ?", row.GoalID, in.SessionID).Error; err != nil {
				return err
			}
			var oldGoal WorkGoal
			if err = decodeWorkGoal(oldRow, &oldGoal); err != nil {
				return err
			}
			keepBackground := false
			var tasks []securityTaskRow
			if err = tx.Where("session_id = ? AND goal_id = ? AND store_id = ? AND recovery_epoch = ? AND state IN ?", in.SessionID, row.GoalID, storeID, epoch, []security.TaskState{security.TaskActive, security.TaskIdle, security.TaskWaiting}).Find(&tasks).Error; err != nil {
				return err
			}
			for _, task := range tasks {
				if task.BackgroundPolicy == "monitored_background" {
					valid, checkErr := taskHasValidMonitor(tx, task.ID, time.Now().UTC())
					if checkErr != nil {
						return checkErr
					}
					if valid {
						keepBackground = true
						continue
					}
				}
				a := SecurityTaskAction{ActorID: in.ActorID, ActionID: in.ActionID + ":pause:" + task.ID, ProjectID: task.ProjectID, SessionID: task.SessionID, GoalID: task.GoalID, TaskID: task.ID, ExpectedRevision: task.StateRevision, Reason: "foreground goal selection changed"}
				to := security.TaskPaused
				if !task.ExpiresAt.After(time.Now().UTC()) {
					to = security.TaskExpired
				}
				if _, err = transitionSecurityTask(tx, storeID, epoch, a, to, time.Now().UTC()); err != nil {
					return err
				}
			}
			if !keepBackground && !workTerminal(oldGoal.Status) && oldGoal.Status != "paused" {
				oldGoal.Status = "paused"
				if err = writeWorkGoalTx(tx, &oldRow, &oldGoal, false); err != nil {
					return err
				}
			}
		}
		result = securityGoalSelectionRow{SessionID: in.SessionID, ProjectID: in.ProjectID, StoreID: storeID, RecoveryEpoch: epoch, GoalID: in.GoalID, SourceMessageID: in.SourceMessageID, GoalRevision: in.ExpectedGoalRevision, Revision: row.Revision + 1, NewGoal: in.NewGoal}
		if row.Revision == 0 {
			err = tx.Create(&result).Error
		} else {
			updated := tx.Model(&securityGoalSelectionRow{}).Where("session_id = ? AND revision = ?", row.SessionID, row.Revision).Select("*").Updates(&result)
			err = updated.Error
			if err == nil && updated.RowsAffected != 1 {
				err = security.ErrConflict
			}
		}
		if err != nil {
			return err
		}
		a := SecurityScopeAction{ActorID: in.ActorID, ActionID: in.ActionID, ProjectID: in.ProjectID, SessionID: in.SessionID, SourceMessageID: in.SourceMessageID}
		return recordScopeAction(tx, storeID, epoch, a, "goal.select", in.SessionID, request, row.Revision, result.Revision, result, time.Now().UTC())
	})
	if err != nil {
		return err
	}
	s, err := e.get(in.SessionID)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.state.SelectedGoalID = result.GoalID
	s.state.PendingGoalIntent = nil
	if pending := s.state.PendingGoalQuestion; pending != nil {
		if s.state.View.Question != nil && s.state.View.Question.ID == pending.Request.ID {
			s.state.View.Question = nil
		}
		s.state.PendingGoalQuestion = nil
	}
	if s.cancel != nil {
		s.cancel()
	}
	return e.save(s)
}

// prepareSecurityTurnLocked runs only for an actual incoming user turn while
// holding the session lock. It never treats model text as a control action.
func (e *Engine) prepareSecurityTurnLocked(ctx context.Context, s *session, c *Config, in TurnInput, sourceID, rootTurnID string) (SecurityExecutionContext, error) {
	if c.superRole == "router" {
		if c.superRouter == nil || c.superRouter.projectID != configSecurityProject(*c) {
			return SecurityExecutionContext{}, errSuperBinding
		}
		s.state.SecurityManaged, s.state.SecurityTaskID, s.state.WorkGoalID = true, "", ""
		c.securityExecution, s.state.Config.securityExecution = nil, nil
		return SecurityExecutionContext{Managed: true, ProjectID: c.superRouter.projectID, SessionID: s.state.View.Session}, nil
	}
	if c.superRole == "worker" {
		if err := e.bindSuperWorkerProposalLocked(ctx, s, c, sourceID); err != nil {
			return SecurityExecutionContext{}, err
		}
		if s.state.WorkGoalID == c.superTaskID {
			_, goal, err := e.workRow(s.state.View.Session, c.superTaskID)
			if err != nil {
				return SecurityExecutionContext{}, err
			}
			if goal.closure == nil {
				return SecurityExecutionContext{Managed: true, ProjectID: configSecurityProject(*c), SessionID: s.state.View.Session, GoalID: goal.ID}, nil
			}
		}
	}
	if e.worker != nil {
		if c.sre != nil && c.sre.NoTools {
			managed, err := e.worker.parent.SecurityProjectManaged(ctx, configSecurityProject(*c))
			if err != nil {
				return SecurityExecutionContext{}, err
			}
			if managed {
				s.state.SecurityManaged = true
				s.state.SecurityTaskID = ""
				s.state.Config.securityExecution = nil
				c.securityExecution = nil
				return SecurityExecutionContext{Managed: true, ProjectID: configSecurityProject(*c), SessionID: e.worker.parentID}, nil
			}
		}
		var parent SecurityExecutionContext
		var err error
		if c.securityExecution != nil && c.securityExecution.StepID != "" && c.securityExecution.AttemptID != "" {
			parent = *c.securityExecution
		} else {
			parent, err = e.worker.parent.CurrentSecurityExecution(ctx, e.worker.parentID)
		}
		if err != nil {
			return parent, err
		}
		if !parent.Managed {
			return parent, nil
		}
		child, err := e.worker.parent.BindSecurityChildExecution(ctx, parent, e.worker.runID)
		if err != nil {
			return child, err
		}
		c.securityExecution = &child
		s.state.Config.securityExecution = &child
		s.state.SecurityManaged, s.state.SecurityTaskID, s.state.SecuritySourceMessageID = true, child.Task.ID, child.SourceMessageID
		return child, nil
	}
	out := SecurityExecutionContext{ProjectID: configSecurityProject(*c), SessionID: s.state.View.Session, SourceMessageID: sourceID}
	configured, err := e.securityPolicyConfigured(out.ProjectID)
	if err != nil {
		return out, err
	}
	if !configured && !s.state.SecurityManaged {
		return out, nil
	}
	out.Managed = true
	s.state.SecurityManaged = true
	if !configured {
		return out, errors.New("security: managed project policy unavailable")
	}
	if c.workflowMode {
		return out, errors.New("security: workflow execution requires a registered task origin")
	}
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return out, err
	}
	var selection securityGoalSelectionRow
	err = db.WithContext(ctx).First(&selection, "session_id = ?", out.SessionID).Error
	if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
		return out, err
	}
	if selection.SessionID != "" && (selection.ProjectID != out.ProjectID || selection.StoreID != storeID || selection.RecoveryEpoch != epoch) {
		return out, errors.New("security: goal selection requires recovery confirmation")
	}
	if in.SecurityIntent == IntentNewGoal || selection.NewGoal {
		c.securityExecution, s.state.Config.securityExecution = nil, nil
		if selection.GoalID != "" {
			return out, errors.New("security: select a new goal through a trusted goal action")
		}
		s.state.SelectedGoalID, s.state.WorkGoalID, s.state.SecurityTaskID, s.state.SecuritySourceMessageID = "", "", "", sourceID
		return out, nil
	}
	goalID := selection.GoalID
	if in.SecurityGoalID != "" && in.SecurityGoalID != goalID {
		return out, errors.New("security: explicit goal selection required")
	}
	if goalID == "" {
		var count int64
		if err = db.Model(&nativeWorkGoal{}).Where("session_id = ? AND status NOT IN ?", out.SessionID, []string{"completed", "cancelled", "failed"}).Count(&count).Error; err != nil {
			return out, err
		}
		if count > 0 {
			return out, e.installSecurityGoalQuestionLocked(s, *c, in, sourceID, selection.Revision)
		}
		c.securityExecution, s.state.Config.securityExecution = nil, nil
		s.state.SelectedGoalID, s.state.WorkGoalID, s.state.SecurityTaskID, s.state.SecuritySourceMessageID = "", "", "", sourceID
		return out, nil // Model may explain/propose a plan, but cannot access resources.
	}
	row, goal, err := e.workRow(out.SessionID, goalID)
	if err != nil {
		return out, err
	}
	if workTerminal(goal.Status) {
		freshHumanSource := e.workParent == nil && in.SecurityIntent == "" && in.SecurityGoalID == "" && strings.TrimSpace(in.UserText) != "" && sourceID != "" && sourceID != selection.SourceMessageID && sourceID != s.state.SecuritySourceMessageID && rootTurnID != ""
		for _, message := range s.state.History {
			if message.Role == "user" && message.SourceMessageID == sourceID {
				freshHumanSource = false
			}
		}
		if !freshHumanSource {
			return out, errors.New("security: terminal goal requires a new actual user request")
		}
		next, pending, advanceErr := e.advanceTerminalSecurityGoal(ctx, selection, sourceID, rootTurnID)
		if advanceErr != nil {
			return out, advanceErr
		}
		// A terminal goal's private execution object must never follow the new
		// user message into proposals, work_begin or an unrelated worker.
		c.securityExecution, s.state.Config.securityExecution = nil, nil
		s.state.SecurityTaskID, s.state.SecuritySourceMessageID = "", sourceID
		if pending {
			return out, e.installSecurityGoalQuestionLocked(s, *c, in, sourceID, selection.Revision)
		}
		s.state.SelectedGoalID, s.state.WorkGoalID = "", ""
		s.state.PendingGoalIntent = nil
		selection = next
		return out, nil // Proposal only: no task, owner, grant or resource permit.
	}
	if goal.closure == nil || goal.closure.ProjectID != out.ProjectID || goal.closure.GoalRevision != selection.GoalRevision {
		return out, errors.New("security: selected goal contract changed; confirm selection again")
	}
	if in.SecurityGoalRevision > 0 && in.SecurityGoalRevision != row.GoalRevision {
		return out, security.ErrConflict
	}
	resolved := ResolveGoalIntent(GoalIntentInput{SessionID: out.SessionID, SourceMessageID: sourceID, UserText: in.UserText, Goals: []IntentGoal{{ID: goal.ID, SessionID: goal.SessionID, GoalRevision: row.GoalRevision, Status: goal.Status}}, Interaction: &GoalInteraction{ID: "selected:" + js(selection.Revision), SessionID: out.SessionID, GoalID: goal.ID, SourceMessageID: sourceID, GoalRevision: row.GoalRevision, State: "active"}})
	if resolved.Intent != IntentContinueGoal {
		return out, errors.New("security: original goal association required")
	}
	if goal.Status == "paused" {
		goal.Status = "running" // Real current-goal continuation; item prerequisites remain unchanged.
		if err = e.writeWorkGoal(&row, &goal, false); err != nil {
			return out, err
		}
	}
	out.GoalID = goal.ID
	err = db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var taskRow securityTaskRow
		err := tx.Where("goal_id = ? AND session_id = ? AND project_id = ? AND store_id = ? AND recovery_epoch = ? AND state NOT IN ? AND expires_at > ?", goal.ID, out.SessionID, out.ProjectID, storeID, epoch, []security.TaskState{security.TaskCompleted, security.TaskCancelled, security.TaskExpired}, time.Now().UTC()).Order("created_at DESC,id DESC").First(&taskRow).Error
		now := time.Now().UTC()
		if errors.Is(err, gorm.ErrRecordNotFound) {
			out.Task, err = beginSecurityTask(tx, storeID, epoch, SecurityTaskStart{Action: SecurityTaskAction{ActorID: "user", ActionID: "turn:" + rootTurnID, ProjectID: out.ProjectID, SessionID: out.SessionID, GoalID: goal.ID}, SourceMessageID: sourceID, ExpectedGoalRevision: row.GoalRevision}, now)
		} else if err == nil {
			out.Task = taskRow.task()
			if out.Task.State != security.TaskActive {
				out.Task, err = transitionSecurityTask(tx, storeID, epoch, SecurityTaskAction{ActorID: "user", ActionID: "turn:" + rootTurnID, ProjectID: out.ProjectID, SessionID: out.SessionID, GoalID: goal.ID, TaskID: out.Task.ID, ExpectedRevision: out.Task.StateRevision}, security.TaskActive, now)
			}
		}
		if err != nil {
			return err
		}
		binding, err := bindSecurityTaskTurn(tx, out.Task.ID, storeID, epoch, rootTurnID, "", out.Task.ExecutionRevision, now)
		if err != nil {
			return err
		}
		out.Owner, err = acquireExecutionOwner(tx, binding.ID, uid(), "agent", binding.OwnerGeneration, now)
		return err
	})
	if err != nil {
		return out, err
	}
	s.state.SelectedGoalID, s.state.WorkGoalID, s.state.SecurityTaskID, s.state.SecuritySourceMessageID = goal.ID, goal.ID, out.Task.ID, sourceID
	s.state.PendingGoalIntent = nil
	e.securityOwners.Store(out.Owner.BindingID, &liveSecurityOwner{owner: out.Owner})
	c.securityExecution = &out
	e.startSecurityLifecycle()
	return out, nil
}

func (e *Engine) CurrentSecurityExecution(ctx context.Context, sessionID string) (out SecurityExecutionContext, err error) {
	s, err := e.get(sessionID)
	if err != nil {
		return out, err
	}
	s.mu.Lock()
	out = SecurityExecutionContext{Managed: s.state.SecurityManaged, ProjectID: configSecurityProject(s.state.Config), SessionID: sessionID, GoalID: s.state.WorkGoalID, SourceMessageID: s.state.SecuritySourceMessageID}
	taskID, rootTurnID := s.state.SecurityTaskID, s.state.View.RootTurnID
	inherited := s.state.Config.securityExecution
	pending := s.state.PendingGoalIntent != nil
	s.mu.Unlock()
	if e.worker == nil && e.workParent == nil {
		inherited = nil
	}
	if inherited != nil {
		out = *inherited
		taskID, rootTurnID = out.Task.ID, out.Owner.RootTurnID
	}
	configured, err := e.securityPolicyConfigured(out.ProjectID)
	if err != nil {
		return out, err
	}
	if configured {
		out.Managed = true
	} else if out.Managed {
		return out, errors.New("security: managed policy unavailable")
	}
	if !out.Managed {
		return out, nil
	}
	if pending {
		return out, errors.New("security: goal association requires confirmation")
	}
	if out.GoalID == "" || taskID == "" {
		return out, errors.New("security: goal, task and acceptance contract required before resource access")
	}
	_, goal, err := e.workRow(out.SessionID, out.GoalID)
	if err != nil {
		return out, fmt.Errorf("security: current execution goal: %w", err)
	}
	liveGoal := goal.Status == "running" || goal.Status == "blocked" || goal.Status == "waiting_user" || goal.Status == "waiting_external"
	if goal.closure == nil || !liveGoal {
		return out, errors.New("security: current step is not ready")
	}
	if inherited != nil && e.worker != nil {
		if inherited.StepID == "" || inherited.AttemptID == "" || goal.closure.ActiveAttempts[inherited.StepID] != inherited.AttemptID || goal.closure.GoalRevision != inherited.GoalRevision || goal.closure.PlanRevision != inherited.PlanRevision || goal.closure.Steps[inherited.StepID].Revision != inherited.StepRevision {
			return out, errors.New("security: original child step/attempt changed; only late evidence may be recorded")
		}
	} else {
		out.StepID = goal.ActiveItemID
		out.AttemptID = goal.closure.ActiveAttempts[out.StepID]
		out.GoalRevision, out.PlanRevision, out.StepRevision = goal.closure.GoalRevision, goal.closure.PlanRevision, goal.closure.Steps[out.StepID].Revision
	}
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return out, err
	}
	if inherited != nil && e.worker != nil {
		ready, stepErr := securityCanonicalStepReady(db.WithContext(ctx), securityStepDescriptor(out), false)
		if stepErr != nil {
			return out, stepErr
		}
		if !ready {
			return out, errors.New("security: original child step/attempt is not currently runnable")
		}
	}
	if out.Task, err = verifySecurityTaskTx(db.WithContext(ctx), taskID, out.SessionID, out.GoalID, rootTurnID, time.Now().UTC()); err != nil {
		return out, fmt.Errorf("security: current execution task: %w", err)
	}
	if out.Task.StoreID != storeID || out.Task.RecoveryEpoch != epoch {
		return out, security.ErrConflict
	}
	var workflow securityWorkflowRunRow
	workflowErr := db.WithContext(ctx).First(&workflow, "task_id = ?", out.Task.ID).Error
	if workflowErr == nil {
		var frozen SecurityWorkflowRunBinding
		if err = json.Unmarshal([]byte(workflow.Data), &frozen); err != nil {
			return out, err
		}
		if workflow.StoreID != storeID || workflow.RecoveryEpoch != epoch || frozen.GoalID != out.GoalID || frozen.SessionID != out.SessionID || frozen.Task.ID != out.Task.ID || len(frozen.Resources) != len(frozen.ResourceIDs) {
			return out, security.ErrConflict
		}
		out.FrozenResources = frozen.Resources
		for _, resource := range out.FrozenResources {
			var current securityResourceRevisionRow
			if err = db.WithContext(ctx).First(&current, "project_id = ? AND resource_id = ?", out.ProjectID, resource.ID).Error; err != nil {
				return out, err
			}
			if current.StoreID != storeID || current.RecoveryEpoch != epoch || current.State != "ready" || current.ConnectionRevision != resource.ConnectionRevision || current.ConnectionDigest != resource.ConnectionDigest {
				return out, errors.New("security: frozen workflow connection changed")
			}
		}
	} else if !errors.Is(workflowErr, gorm.ErrRecordNotFound) {
		return out, workflowErr
	}
	var binding securityTaskBinding
	scopeID := ""
	if inherited != nil {
		scopeID = inherited.Owner.ScopeID
	}
	if err = db.WithContext(ctx).Where("task_id = ? AND root_turn_id = ? AND scope_id = ? AND state = ?", taskID, rootTurnID, scopeID, "active").First(&binding).Error; err != nil {
		return out, fmt.Errorf("security: current execution owner binding: %w", err)
	}
	live, ok := e.securityOwnerEngine().securityOwners.Load(binding.ID)
	if !ok {
		return out, errExecutionOwner
	}
	entry := live.(*liveSecurityOwner)
	entry.mu.Lock()
	out.Owner = entry.owner
	entry.mu.Unlock()
	if err = ValidateExecutionOwner(db.WithContext(ctx), out.Owner, time.Now().UTC()); err != nil {
		return out, err
	}
	return out, nil
}

func (e *Engine) securityOwnerEngine() *Engine {
	owner, _ := securityRootEngine(e)
	return owner
}

// BindSecurityChildExecution creates a separately fenced scope under the same
// task. It shares remaining authority/budget, never copies or extends a grant.
func (e *Engine) BindSecurityChildExecution(ctx context.Context, parent SecurityExecutionContext, scopeID string) (out SecurityExecutionContext, err error) {
	out = parent
	if !parent.Managed {
		return out, nil
	}
	if scopeID == "" || parent.Owner.ScopeID != "" {
		return out, errSecurityAction
	}
	if parent.StepID == "" || parent.AttemptID == "" || parent.GoalRevision < 1 || parent.PlanRevision < 1 || parent.StepRevision < 1 {
		return out, errors.New("security: child requires an existing versioned step and attempt")
	}
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return out, err
	}
	if parent.Task.StoreID != storeID || parent.Task.RecoveryEpoch != epoch {
		return out, security.ErrConflict
	}
	err = db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var refreshErr error
		parent.Owner, refreshErr = refreshExecutionOwnerLease(tx, parent.Owner, time.Now().UTC())
		if refreshErr != nil {
			return refreshErr
		}
		var row nativeWorkGoal
		if err := tx.First(&row, "id = ? AND session_id = ?", parent.GoalID, parent.SessionID).Error; err != nil {
			return err
		}
		var goal WorkGoal
		if err := decodeWorkGoal(row, &goal); err != nil {
			return err
		}
		if goal.closure == nil || goal.closure.ActiveAttempts[parent.StepID] != parent.AttemptID || goal.closure.GoalRevision != parent.GoalRevision || goal.closure.PlanRevision != parent.PlanRevision || goal.closure.Steps[parent.StepID].Revision != parent.StepRevision {
			return security.ErrConflict
		}
		ready, err := securityCanonicalStepReady(tx, securityStepDescriptor(parent), false)
		if err != nil {
			return err
		}
		if !ready {
			return security.ErrConflict
		}
		binding, err := bindSecurityTaskTurn(tx, parent.Task.ID, storeID, epoch, parent.Owner.RootTurnID, scopeID, parent.Task.ExecutionRevision, time.Now().UTC())
		if err != nil {
			return err
		}
		out.Owner, err = acquireExecutionOwner(tx, binding.ID, uid(), "agent", binding.OwnerGeneration, time.Now().UTC())
		return err
	})
	if err == nil {
		e.securityOwnerEngine().securityOwners.Store(out.Owner.BindingID, &liveSecurityOwner{owner: out.Owner})
	}
	return out, err
}

func securityStepDescriptor(execution SecurityExecutionContext) security.PreparedOperation {
	return security.PreparedOperation{ProjectID: execution.ProjectID, SessionID: execution.SessionID, GoalID: execution.GoalID, GoalRevision: execution.GoalRevision, PlanRevision: execution.PlanRevision, StepID: execution.StepID, StepRevision: execution.StepRevision, AttemptID: execution.AttemptID, TaskID: execution.Task.ID, StoreID: execution.Task.StoreID, RecoveryEpoch: execution.Task.RecoveryEpoch, RootTurnID: execution.Owner.RootTurnID, ChildScopeID: execution.Owner.ScopeID, ExecutionRevision: execution.Task.ExecutionRevision, OwnerID: execution.Owner.OwnerID, OwnerGeneration: execution.Owner.Generation}
}

// SetOrphanCleanupResolver is a trusted host registration; no model-configured
// command or arbitrary terminal can become a cleanup adapter.
func (e *Engine) SetOrphanCleanupResolver(resolver OrphanAdapterResolver) {
	owner, err := securityRootEngine(e)
	if err != nil {
		return
	}
	owner.securityLifeMu.Lock()
	owner.securityCleanupResolver = composeManagedShellCleanup(owner, resolver)
	owner.securityLifeMu.Unlock()
}

func (e *Engine) startSecurityLifecycle() {
	if e.workParent != nil || e.worker != nil {
		return
	}
	e.securityStart.Do(func() {
		ctx, cancel := context.WithCancel(context.Background())
		e.securityLifeMu.Lock()
		e.securityCancel = cancel
		e.securityDone = make(chan struct{})
		e.securityWake = make(chan struct{}, 1)
		done := e.securityDone
		wake := e.securityWake
		e.securityLifeMu.Unlock()
		go func() {
			defer close(done)
			e.securityRuntimeTick(ctx, time.Now().UTC())
			ticker := time.NewTicker(ExecutionOwnerHeartbeat)
			defer ticker.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case now := <-ticker.C:
					e.securityRuntimeTick(ctx, now.UTC())
				case <-wake:
					e.securityRuntimeTick(ctx, time.Now().UTC())
				}
			}
		}()
	})
}

func (e *Engine) securityRuntimeTick(ctx context.Context, now time.Time) {
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return
	}
	if err = db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var expired []securityTaskRow
		if err := tx.Where("store_id = ? AND recovery_epoch = ? AND expires_at <= ? AND state NOT IN ?", storeID, epoch, now, []security.TaskState{security.TaskCompleted, security.TaskCancelled, security.TaskExpired}).Find(&expired).Error; err != nil {
			return err
		}
		for _, task := range expired {
			if _, err := transitionSecurityTask(tx, storeID, epoch, SecurityTaskAction{ActorID: "runtime", ActionID: "task-expired:" + task.ID, ProjectID: task.ProjectID, SessionID: task.SessionID, GoalID: task.GoalID, TaskID: task.ID, ExpectedRevision: task.StateRevision, Reason: "absolute task expiry reached"}, security.TaskExpired, now); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		return
	}
	e.securityOwners.Range(func(key, value any) bool {
		entry := value.(*liveSecurityOwner)
		entry.mu.Lock()
		err := db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			var owner ExecutionOwner
			var err error
			if entry.owner.OwnerKind == "monitor" {
				owner, err = RenewExecutionMonitorTx(tx, entry.owner, now)
			} else {
				owner, err = renewExecutionOwner(tx, entry.owner, now)
			}
			if err == nil {
				entry.owner = owner
			}
			return err
		})
		original := entry.owner
		entry.mu.Unlock()
		if err != nil {
			if original.OwnerKind == "monitor" {
				_ = db.WithContext(ctx).Transaction(func(tx *gorm.DB) error { return CloseCompletedExecutionMonitorTx(tx, original, now) })
			}
			e.securityOwners.Delete(key)
		}
		return ctx.Err() == nil
	})
	e.securityLifeMu.Lock()
	resolver := e.securityCleanupResolver
	e.securityLifeMu.Unlock()
	_ = ReconcileOrphanedExecutions(ctx, db, storeID, epoch, now, resolver)
}

func (e *Engine) finishSecurityTurn(execution SecurityExecutionContext, failed bool) error {
	if !execution.Managed || execution.Task.ID == "" {
		return nil
	}
	manager := e.securityOwnerEngine()
	if manager == nil {
		return errors.New("security: runtime ownership unavailable")
	}
	defer manager.securityOwners.Delete(execution.Owner.BindingID)
	authorizer := execution.Owner
	if value, ok := manager.securityOwners.Load(authorizer.BindingID); ok {
		entry := value.(*liveSecurityOwner)
		entry.mu.Lock()
		authorizer = entry.owner
		entry.mu.Unlock()
	}
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return err
	}
	var monitors []ExecutionOwner
	err = db.Transaction(func(tx *gorm.DB) error {
		var row securityTaskRow
		if err := tx.First(&row, "id = ?", execution.Task.ID).Error; err != nil {
			return err
		}
		if row.State != security.TaskActive {
			return nil
		}
		var goal nativeWorkGoal
		if err := tx.First(&goal, "id = ? AND session_id = ?", execution.GoalID, execution.SessionID).Error; err != nil {
			return err
		}
		var operations []nativeOperation
		query := tx.Where("security_task_id = ? AND root_turn_id = ? AND (status IN ? OR (orphan_state <> '' AND risk_resolved_at IS NULL)) AND (closure_state IS NULL OR closure_state <> ?)", execution.Task.ID, execution.Owner.RootTurnID, []string{"dispatched", "unknown"}, "reconciled")
		if err = query.Find(&operations).Error; err != nil {
			return err
		}
		selected := make([]nativeOperation, 0, len(operations))
		for _, op := range operations {
			scope, known := operationOwnerScope(op)
			if execution.Owner.ScopeID == "" || known && scope == execution.Owner.ScopeID {
				selected = append(selected, op)
			}
		}
		if !failed && !workTerminal(goal.Status) && row.BackgroundPolicy == "monitored_background" {
			for _, op := range selected {
				monitor, monitorErr := AcquireExecutionMonitorTx(tx, op.ID, authorizer, time.Now().UTC())
				if monitorErr == nil {
					monitors = append(monitors, monitor)
				} else if !errors.Is(monitorErr, errExecutionMonitor) && !errors.Is(monitorErr, errExecutionOwner) && !errors.Is(monitorErr, security.ErrTaskExpired) && !errors.Is(monitorErr, security.ErrTaskEnded) {
					return monitorErr
				}
			}
		}
		if execution.Owner.ScopeID != "" {
			if err = fenceExecutionOwner(tx, execution.Owner, time.Now().UTC()); err != nil {
				return err
			}

		} else {
			to := security.TaskIdle
			if failed {
				to = security.TaskPaused
			}
			if goal.Status == "completed" {
				to = security.TaskCompleted
			} else if goal.Status == "cancelled" {
				to = security.TaskCancelled
			}
			if _, err = transitionSecurityTask(tx, storeID, epoch, SecurityTaskAction{ActorID: "runtime", ActionID: "turn-end:" + execution.Owner.RootTurnID, ProjectID: execution.ProjectID, SessionID: execution.SessionID, GoalID: execution.GoalID, TaskID: execution.Task.ID, ExpectedRevision: row.StateRevision, Reason: "turn ended; goal acceptance remains authoritative"}, to, time.Now().UTC()); err != nil {
				return err
			}
		}
		_, err = markOrphanedBatch(tx, storeID, epoch, time.Now().UTC(), selected)
		return err
	})
	if err == nil {
		for _, monitor := range monitors {
			manager.securityOwners.Store(monitor.BindingID, &liveSecurityOwner{owner: monitor})
		}
		manager.securityLifeMu.Lock()
		wake := manager.securityWake
		manager.securityLifeMu.Unlock()
		if wake != nil {
			select {
			case wake <- struct{}{}:
			default:
			}
		}
	}
	return err
}

func (e *Engine) stopSecurityLifecycle() {
	e.securityLifeMu.Lock()
	cancel, done := e.securityCancel, e.securityDone
	e.securityLifeMu.Unlock()
	if cancel != nil {
		cancel()
		<-done
	}
}

// advanceTerminalSecurityGoal is an automatic host association for one actual
// new user message. It creates no goal, task, grant or execution authority.
func (e *Engine) advanceTerminalSecurityGoal(ctx context.Context, selected securityGoalSelectionRow, sourceID, rootTurnID string) (next securityGoalSelectionRow, pending bool, err error) {
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return next, false, err
	}
	request := js(struct {
		Previous                    securityGoalSelectionRow
		SourceMessageID, RootTurnID string
	}{selected, sourceID, rootTurnID})
	actor, action := "host:user-turn", "terminal-goal-turn:"+rootTurnID
	err = e.withSecurityDispatchBarrier(func() error {
		return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			var current securityGoalSelectionRow
			if err := tx.First(&current, "session_id = ?", selected.SessionID).Error; err != nil {
				return err
			}
			if current.Revision != selected.Revision || current.GoalID != selected.GoalID || current.ProjectID != selected.ProjectID || current.StoreID != storeID || current.RecoveryEpoch != epoch {
				return security.ErrConflict
			}
			var old nativeWorkGoal
			if err := tx.First(&old, "id = ? AND session_id = ?", selected.GoalID, selected.SessionID).Error; err != nil {
				return err
			}
			var oldGoal WorkGoal
			if err := decodeWorkGoal(old, &oldGoal); err != nil {
				return err
			}
			if !workTerminal(oldGoal.Status) || oldGoal.closure == nil || oldGoal.closure.ProjectID != selected.ProjectID || old.GoalRevision != selected.GoalRevision {
				return security.ErrConflict
			}
			var count int64
			if err := tx.Model(&nativeWorkGoal{}).Where("session_id = ? AND status NOT IN ?", selected.SessionID, []string{"completed", "cancelled", "failed"}).Count(&count).Error; err != nil {
				return err
			}
			if count > 0 {
				pending = true
				return nil
			}
			now := time.Now().UTC()
			var tasks []securityTaskRow
			if err := tx.Where("goal_id = ? AND session_id = ? AND store_id = ? AND recovery_epoch = ? AND state NOT IN ?", selected.GoalID, selected.SessionID, storeID, epoch, []security.TaskState{security.TaskCompleted, security.TaskCancelled, security.TaskExpired}).Find(&tasks).Error; err != nil {
				return err
			}
			for _, task := range tasks {
				to := security.TaskCancelled
				if oldGoal.Status == "completed" {
					to = security.TaskCompleted
				}
				if !task.ExpiresAt.After(now) {
					to = security.TaskExpired
				}
				if _, err := transitionSecurityTask(tx, storeID, epoch, SecurityTaskAction{ActorID: actor, ActionID: action + ":close:" + task.ID, ProjectID: task.ProjectID, SessionID: task.SessionID, GoalID: task.GoalID, TaskID: task.ID, ExpectedRevision: task.StateRevision, Reason: "terminal goal retained; actual new user request starts a proposal"}, to, now); err != nil {
					return err
				}
			}
			next = securityGoalSelectionRow{SessionID: selected.SessionID, ProjectID: selected.ProjectID, StoreID: storeID, RecoveryEpoch: epoch, SourceMessageID: sourceID, Revision: current.Revision + 1, NewGoal: true}
			updated := tx.Model(&securityGoalSelectionRow{}).Where("session_id = ? AND revision = ?", selected.SessionID, selected.Revision).Select("*").Updates(&next)
			if updated.Error != nil {
				return updated.Error
			}
			if updated.RowsAffected != 1 {
				return security.ErrConflict
			}
			return recordScopeAction(tx, storeID, epoch, SecurityScopeAction{ActorID: actor, ActionID: action, ProjectID: selected.ProjectID, SessionID: selected.SessionID, SourceMessageID: sourceID}, "goal.new_after_terminal", selected.SessionID, request, selected.Revision, next.Revision, map[string]any{"selection": next, "previous_goal_id": selected.GoalID, "source_root_turn_id": rootTurnID}, now)
		})
	})
	return next, pending, err
}
