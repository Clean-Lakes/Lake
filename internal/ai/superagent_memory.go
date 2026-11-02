package ai

import (
	"context"
	"encoding/json"
	"errors"

	"gorm.io/gorm"
)

type superMemoryReadKey struct{}
type superMemoryReadBinding struct{ sessionID, projectID string }

func withSuperMemoryRead(ctx context.Context, sessionID, projectID string) context.Context {
	return context.WithValue(ctx, superMemoryReadKey{}, superMemoryReadBinding{sessionID: sessionID, projectID: projectID})
}

// Host metadata only, separate from bearqy's immutable snapshot/hash contract.
// References never grant Memory consent, resource access or task acceptance.
type SuperMemoryContext struct {
	ProjectID    string                 `json:"projectId"`
	TaskID       string                 `json:"taskId,omitempty"`
	WorkerID     string                 `json:"workerId,omitempty"`
	Role         string                 `json:"role"`
	Purpose      string                 `json:"purpose"`
	TaskRevision int64                  `json:"taskRevision,omitempty"`
	GoalRevision int64                  `json:"goalRevision,omitempty"`
	PlanRevision int64                  `json:"planRevision,omitempty"`
	Ledger       []SuperMemoryLedgerRef `json:"ledger,omitempty"`
	Truncated    bool                   `json:"truncated,omitempty"`
	Resources    []WorkBinding          `json:"resources,omitempty"`
	SourceRefs   []SuperMemorySourceRef `json:"sourceRefs,omitempty"`
}
type SuperMemoryLedgerRef struct {
	Kind      string `json:"kind"`
	ID        string `json:"id"`
	StepID    string `json:"stepId,omitempty"`
	AttemptID string `json:"attemptId,omitempty"`
	State     string `json:"state,omitempty"`
}
type SuperMemorySourceRef struct {
	EventID         string `json:"eventId"`
	SessionID       string `json:"sessionId"`
	SourceMessageID string `json:"sourceMessageId"`
	Hash            string `json:"hash"`
}
type SuperMemoryView struct {
	Context   SuperMemoryContext `json:"context"`
	Available bool               `json:"available"`
	Reason    string             `json:"reason,omitempty"`
}

func (e *Engine) MemoryForRouter(ctx context.Context, sessionID string) (SuperMemoryView, error) {
	c, err := e.superReadConfig(sessionID)
	if err != nil || c.superRole != "router" {
		return SuperMemoryView{}, errSuperBinding
	}
	out := SuperMemoryView{Context: SuperMemoryContext{ProjectID: configSecurityProject(c), Role: "router", Purpose: "preference_use"}}
	if err := e.CheckSecurityMemoryEligibility(ctx, c.MemoryProjectID, SecurityMemoryUse); err != nil {
		out.Reason = "memory_eligibility_closed"
		return out, nil
	}
	out.Available = naturalRecallAllowed(c) && e.NaturalMemory != nil && c.NaturalMemory != nil && (c.NaturalMemory.GlobalEnabled || c.NaturalMemory.ProjectEnabled)
	if !out.Available {
		out.Reason = "natural_memory_unavailable"
	}
	return out, nil
}

// V1 has no verified asset-scoped task-knowledge view; V2 remains gated. A
// specialist cannot inherit the Router's global preferences or whole project
// knowledge to compensate. This explicit result is safe to show to the host.
func (e *Engine) MemoryForWorker(ctx context.Context, projectID, workerID string) (SuperMemoryView, error) {
	db, err := e.superStore()
	if err != nil {
		return SuperMemoryView{}, err
	}
	out := SuperMemoryView{Reason: "task_knowledge_view_unavailable"}
	err = db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		w, err := superWorkerInProject(tx, workerID, projectID)
		if err != nil {
			return err
		}
		_, goal, err := loadSuperGoalTx(tx, w)
		if err != nil {
			return err
		}
		out.Context = SuperMemoryContext{ProjectID: projectID, TaskID: w.TaskID, WorkerID: w.ID, Role: "worker", Purpose: "task_knowledge_read", Resources: goal.ResourceBindings, TaskRevision: goal.Revision}
		if goal.closure != nil {
			out.Context.GoalRevision, out.Context.PlanRevision = goal.closure.GoalRevision, goal.closure.PlanRevision
		}
		stepID, attemptID := "", ""
		if w.ParentWorkerID != "" {
			out.Context.Role = "child"
			out.Context.Resources = nil
			var scope securityParentRestrictionRow
			if err := tx.First(&scope, "scope_id = ? AND goal_id = ? AND project_id = ?", w.ScopeID, w.TaskID, projectID).Error; errors.Is(err, gorm.ErrRecordNotFound) {
				out.Reason = "child_scope_unavailable"
				return nil
			} else if err != nil {
				return err
			}
			var ids []string
			if err := json.Unmarshal([]byte(scope.ResourceIDs), &ids); err != nil {
				return err
			}
			allowed := map[string]bool{}
			for _, id := range ids {
				allowed[id] = true
			}
			for _, binding := range goal.ResourceBindings {
				if allowed[binding.AssetRef] {
					out.Context.Resources = append(out.Context.Resources, binding)
				}
			}
			stepID, attemptID = scope.StepID, scope.AttemptID
		}
		if err := superMemoryLedgerTx(tx, w, &out.Context, stepID, attemptID); err != nil {
			return err
		}
		var event superEventRow
		if w.SourceEventID != "" {
			if err := tx.First(&event, "id = ? AND project_id = ?", w.SourceEventID, projectID).Error; err != nil {
				return err
			}
			out.Context.SourceRefs = []SuperMemorySourceRef{{EventID: event.ID, SessionID: event.ThreadRef, SourceMessageID: event.SourceEventID, Hash: event.PayloadHash}}
		}
		return nil
	})
	return out, err
}

// Exact references only. No tool output, synthesized successful lesson, or
// snapshot/hash change is introduced into bearqy's existing capture protocol.
func superMemoryLedgerTx(tx *gorm.DB, w superWorkerRow, out *SuperMemoryContext, step, attempt string) error {
	query := tx.Where("goal_id = ? AND project_id = ?", w.TaskID, w.ProjectID)
	if step != "" {
		query = query.Where("step_id = ? AND id = ?", step, attempt)
	}
	var attempts []workExecutionAttempt
	if err := query.Order("id").Limit(129).Find(&attempts).Error; err != nil {
		return err
	}
	for i, row := range attempts {
		if i == 128 {
			out.Truncated = true
			break
		}
		out.Ledger = append(out.Ledger, SuperMemoryLedgerRef{Kind: "attempt", ID: row.ID, StepID: row.StepID, State: row.State})
	}
	opsQuery := tx.Where("goal_id = ? AND project_id = ?", w.TaskID, w.ProjectID)
	if step != "" {
		opsQuery = opsQuery.Where("step_id = ? AND attempt_id = ?", step, attempt)
	}
	var operations []nativeOperation
	if err := opsQuery.Order("id").Limit(129).Find(&operations).Error; err != nil {
		return err
	}
	for i, row := range operations {
		if i == 128 {
			out.Truncated = true
			break
		}
		out.Ledger = append(out.Ledger, SuperMemoryLedgerRef{Kind: "operation", ID: row.ID, StepID: row.StepID, AttemptID: row.AttemptID, State: row.Status})
	}
	acceptQuery := tx.Where("goal_id = ? AND project_id = ?", w.TaskID, w.ProjectID)
	if step != "" {
		acceptQuery = acceptQuery.Where("step_id = ? AND attempt_id = ?", step, attempt)
	}
	var acceptances []workAcceptanceRecord
	if err := acceptQuery.Order("id").Limit(129).Find(&acceptances).Error; err != nil {
		return err
	}
	for i, row := range acceptances {
		if i == 128 {
			out.Truncated = true
			break
		}
		out.Ledger = append(out.Ledger, SuperMemoryLedgerRef{Kind: "acceptance", ID: row.ID, StepID: row.StepID, AttemptID: row.AttemptID, State: row.State})
		var ids []string
		if json.Unmarshal([]byte(row.EvidenceIDs), &ids) == nil {
			for _, id := range ids {
				out.Ledger = append(out.Ledger, SuperMemoryLedgerRef{Kind: "evidence", ID: id, StepID: row.StepID, AttemptID: row.AttemptID})
			}
		}
	}
	return nil
}

// Ordinary preferences retain no task ID. A source is linked only when one
// actual root Worker uniquely owns that exact committed source message.
func (e *Engine) SuperMemorySourceContext(ctx context.Context, project, session, message string) (*SuperMemoryContext, error) {
	store, err := e.adkStore()
	if err != nil {
		return nil, err
	}
	if !store.DB.Migrator().HasTable(&superWorkerRow{}) || message == "" {
		return nil, nil
	}
	var rows []superWorkerRow
	err = store.DB.WithContext(ctx).Where("project_id = ? AND parent_worker_id = '' AND source_event_id IN (?)", project, store.DB.Model(&superEventRow{}).Select("id").Where("project_id = ? AND thread_ref = ? AND source_event_id = ? AND source_kind = ?", project, session, message, "user")).Limit(2).Find(&rows).Error
	if err != nil || len(rows) != 1 {
		return nil, err
	}
	view, err := e.MemoryForWorker(ctx, project, rows[0].ID)
	if err != nil {
		return nil, err
	}
	return &view.Context, nil
}
