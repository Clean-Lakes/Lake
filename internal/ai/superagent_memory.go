package ai

import (
	"context"

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
	ProjectID  string                 `json:"projectId"`
	TaskID     string                 `json:"taskId,omitempty"`
	WorkerID   string                 `json:"workerId,omitempty"`
	Role       string                 `json:"role"`
	Purpose    string                 `json:"purpose"`
	Resources  []WorkBinding          `json:"resources,omitempty"`
	SourceRefs []SuperMemorySourceRef `json:"sourceRefs,omitempty"`
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
		out.Context = SuperMemoryContext{ProjectID: projectID, TaskID: w.TaskID, WorkerID: w.ID, Role: "worker", Purpose: "task_knowledge_read", Resources: goal.ResourceBindings}
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
