package ai

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"time"

	"github.com/Clean-Lakes/Lake/internal/security"
	"gorm.io/gorm"
)

type securityProviderContextKey struct{}
type securityProviderDeadlineKey struct{}
type securityProviderGuard func(context.Context) error

type securityProviderBinding struct {
	deadline                              time.Time
	execution                             SecurityExecutionContext
	goalRevision                          int64
	parentOwner                           *ExecutionOwner
	source                                *Engine
	sourceSession, sourceRoot, driverRoot string
}
type securityProviderSource struct {
	root, goal, task, project string
	managed                   bool
	execution                 *SecurityExecutionContext
}

func providerSource(s *session) securityProviderSource {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := securityProviderSource{root: s.state.View.RootTurnID, goal: s.state.WorkGoalID, task: s.state.SecurityTaskID, project: configSecurityProject(s.state.Config), managed: s.state.SecurityManaged}
	if s.state.Config.securityExecution != nil {
		copy := *s.state.Config.securityExecution
		out.execution = &copy
	}
	return out
}

// Freeze the actual host owner once for this driver. A queued request never
// looks up and adopts a replacement owner after a fence or a new user turn.
func (d *adkTurnDriver) securityProviderContext(ctx context.Context, tools []Tool) (context.Context, []Tool, error) {
	d.providerSecurityMu.Lock()
	defer d.providerSecurityMu.Unlock()
	e := d.engine
	own := providerSource(d.session)
	if d.providerSecurityRoot == "" {
		d.providerSecurityRoot = own.root
	}
	if own.root != d.providerSecurityRoot {
		return ctx, tools, errExecutionOwner
	}
	source, sourceSession, expectedRoot := e, own, ""
	if e.worker != nil {
		source = e.worker.parent
		sourceState, err := source.get(e.worker.parentID)
		if err != nil {
			return ctx, tools, err
		}
		sourceSession = providerSource(sourceState)
		expectedRoot = e.worker.turnID
		if sourceSession.root != expectedRoot {
			return ctx, tools, errExecutionOwner
		}
	}
	managed, err := source.securityPolicyConfigured(sourceSession.project)
	if err != nil {
		return ctx, tools, err
	}
	managed = managed || sourceSession.managed
	if !managed && d.providerSecurity == nil {
		d.providerSecurityInitialized = true
		return ctx, tools, nil
	}
	sourceID := ownSessionID(d.session)
	if e.worker != nil {
		sourceID = e.worker.parentID
	}
	if d.providerSecurity == nil {
		candidate := d.config.securityExecution
		if candidate == nil {
			candidate = sourceSession.execution
		}
		// A task activated by the just-confirmed work proposal installs this exact
		// private snapshot. NoTask explanation/proposal requests need no fake task.
		if sourceSession.task == "" && (candidate == nil || candidate.Task.ID == "") {
			d.providerSecurityInitialized = true
			guard := securityProviderGuard(func(context.Context) error {
				if providerSource(d.session).root != d.providerSecurityRoot {
					return errExecutionOwner
				}
				state, err := source.get(sourceID)
				if err != nil {
					return err
				}
				current := providerSource(state)
				if current.root != sourceSession.root || current.task != "" {
					return errors.New("security: proposal context changed while waiting for provider")
				}
				return nil
			})
			return context.WithValue(ctx, securityProviderContextKey{}, guard), tools, nil
		}
		db, storeID, epoch, err := source.securityTaskDB()
		if err != nil {
			return ctx, tools, err
		}
		// Existing workflow/NoTools coordinators may have an actual task without a
		// resource step. Initial construction captures its live root owner only.
		// After initialization, only a host-installed activation snapshot is valid.
		if candidate == nil {
			if d.providerSecurityInitialized {
				return ctx, tools, errExecutionOwner
			}
			var row securityTaskBinding
			if err = db.First(&row, "task_id = ? AND root_turn_id = ? AND scope_id = '' AND state = ?", sourceSession.task, sourceSession.root, "active").Error; err != nil {
				return ctx, tools, err
			}
			owner := bindingOwner(row)
			candidate = &SecurityExecutionContext{Managed: true, ProjectID: sourceSession.project, SessionID: sourceID, GoalID: sourceSession.goal, Task: security.SecurityTask{ID: sourceSession.task, StoreID: storeID, RecoveryEpoch: epoch}, Owner: owner}
		}
		copy := *candidate
		if !copy.Managed || copy.Task.ID == "" || copy.Owner.OwnerID == "" || copy.Owner.RootTurnID != sourceSession.root || copy.Task.ID != sourceSession.task || copy.GoalID != sourceSession.goal || copy.ProjectID != sourceSession.project || copy.SessionID != sourceID {
			return ctx, tools, errExecutionOwner
		}
		var task securityTaskRow
		if err = db.First(&task, "id = ?", copy.Task.ID).Error; err != nil {
			return ctx, tools, err
		}
		if task.StoreID != storeID || task.RecoveryEpoch != epoch || copy.GoalRevision > 0 && copy.GoalRevision != task.GoalRevision {
			return ctx, tools, security.ErrConflict
		}
		binding := &securityProviderBinding{execution: copy, goalRevision: task.GoalRevision, deadline: task.ExpiresAt, source: source, sourceSession: sourceID, sourceRoot: sourceSession.root, driverRoot: d.providerSecurityRoot}
		if copy.Owner.ScopeID != "" {
			var parent securityTaskBinding
			if err = db.First(&parent, "task_id = ? AND root_turn_id = ? AND scope_id = '' AND state = ?", copy.Task.ID, copy.Owner.RootTurnID, "active").Error; err != nil {
				return ctx, tools, err
			}
			owner := bindingOwner(parent)
			binding.parentOwner = &owner
		}
		d.providerSecurity = binding
	}
	d.providerSecurityInitialized = true
	binding := d.providerSecurity
	// Completion does not grant another tool round. The original still-live
	// owner can report the already verified goal without proposing new I/O.
	completed, err := binding.goalCompleted(ctx)
	if err != nil {
		return ctx, tools, err
	}
	if completed {
		tools = nil
	}
	summaryOnly := len(tools) == 0
	guard := securityProviderGuard(func(checkCtx context.Context) error { return binding.validate(checkCtx, d.session, summaryOnly) })
	if err := guard(ctx); err != nil {
		return ctx, tools, err
	}
	ctx = context.WithValue(ctx, securityProviderDeadlineKey{}, binding.deadline)
	return context.WithValue(ctx, securityProviderContextKey{}, guard), tools, nil
}
func ownSessionID(s *session) string { s.mu.Lock(); defer s.mu.Unlock(); return s.state.View.Session }
func (b *securityProviderBinding) goalCompleted(ctx context.Context) (bool, error) {
	db, _, _, err := b.source.securityTaskDB()
	if err != nil {
		return false, err
	}
	var goal nativeWorkGoal
	if err = db.WithContext(ctx).Select("status").First(&goal, "id = ? AND session_id = ?", b.execution.GoalID, b.execution.SessionID).Error; err != nil {
		return false, err
	}
	return goal.Status == "completed", nil
}
func (b *securityProviderBinding) validate(ctx context.Context, driver *session, summaryOnly bool) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if providerSource(driver).root != b.driverRoot {
		return errExecutionOwner
	}
	s, err := b.source.get(b.sourceSession)
	if err != nil {
		return err
	}
	current := providerSource(s)
	if current.root != b.sourceRoot || current.task != b.execution.Task.ID || current.goal != b.execution.GoalID {
		return errExecutionOwner
	}
	db, storeID, epoch, err := b.source.securityTaskDB()
	if err != nil {
		return err
	}
	return b.source.withSecurityDispatchBarrier(func() error {
		return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			now := time.Now().UTC()
			var task securityTaskRow
			if err := tx.First(&task, "id = ?", b.execution.Task.ID).Error; err != nil {
				return err
			}
			if task.StoreID != storeID || task.RecoveryEpoch != epoch || task.GoalRevision != b.goalRevision || task.State != security.TaskActive || !task.ExpiresAt.After(now) {
				return errExecutionOwner
			}
			if err := ValidateSecurityScheduleTaskSource(tx, task.ID, storeID, epoch, now); err != nil {
				return err
			}
			var goal nativeWorkGoal
			if err := tx.First(&goal, "id = ? AND session_id = ?", b.execution.GoalID, b.execution.SessionID).Error; err != nil {
				return err
			}
			if goal.GoalRevision != b.goalRevision || !slices.Contains([]string{"running", "blocked", "waiting_user", "waiting_external", "completed"}, goal.Status) || goal.Status == "completed" && !summaryOnly {
				return errExecutionOwner
			}
			var contract WorkClosureContract
			if json.Unmarshal([]byte(goal.ClosureContract), &contract) != nil || contract.GoalRevision != b.goalRevision {
				return security.ErrConflict
			}
			if b.execution.Owner.ScopeID != "" && b.execution.StepID != "" && (contract.PlanRevision != b.execution.PlanRevision || contract.Steps[b.execution.StepID].Revision != b.execution.StepRevision || contract.ActiveAttempts[b.execution.StepID] != b.execution.AttemptID) {
				return security.ErrConflict
			}
			checkOwner := func(frozen ExecutionOwner) error {
				var row securityTaskBinding
				if err := tx.First(&row, "id = ?", frozen.BindingID).Error; err != nil {
					return err
				}
				if row.OwnerID != frozen.OwnerID || row.OwnerGeneration != frozen.Generation {
					return errExecutionOwner
				}
				frozen.LeaseUntil = row.LeaseUntil // renew the same generation, never adopt.
				if err := ValidateExecutionOwner(tx, frozen, now); err != nil {
					return err
				}
				manager := b.source.securityOwnerEngine()
				if manager == nil {
					return errExecutionOwner
				}
				live, ok := manager.securityOwners.Load(frozen.BindingID)
				if !ok {
					return errExecutionOwner
				}
				entry := live.(*liveSecurityOwner)
				entry.mu.Lock()
				same := entry.owner.OwnerID == frozen.OwnerID && entry.owner.Generation == frozen.Generation
				entry.mu.Unlock()
				if !same {
					return errExecutionOwner
				}
				return nil
			}
			if err := checkOwner(b.execution.Owner); err != nil {
				return err
			}
			if b.parentOwner != nil {
				return checkOwner(*b.parentOwner)
			}
			return nil
		})
	})
}
func (e *Engine) checkSecurityProviderContext(ctx context.Context) error {
	if err := e.CheckSecurityRuntime(); err != nil {
		return err
	}
	// Independent Memory/strategy background requests use their own consent and
	// epoch fences. They never acquire a task permit from a conversation guard.
	if ctx.Value(auxiliaryModelKey{}) == true {
		return nil
	}
	guard, _ := ctx.Value(securityProviderContextKey{}).(securityProviderGuard)
	if guard != nil {
		return guard(ctx)
	}
	return nil
}
