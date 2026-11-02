package ai

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"

	"gorm.io/gorm"
)

type superRouterRun struct {
	projectID string
	binding   SuperSourceBinding
	events    map[string]bool
	remaining int
}
type SuperDecision struct {
	EventID string `json:"eventId"`
	PartKey string `json:"partKey"`
	Action  string `json:"action"`
	TaskID  string `json:"taskId,omitempty"`
	Title   string `json:"title,omitempty"`
	RoleKey string `json:"roleKey,omitempty"`
	Quote   string `json:"quote,omitempty"`
	Reason  string `json:"reason"`
}
type SuperRouteResult struct {
	DecisionID string `json:"decisionId"`
	TaskID     string `json:"taskId,omitempty"`
	WorkerID   string `json:"workerId,omitempty"`
	SessionID  string `json:"sessionId,omitempty"`
	Action     string `json:"action"`
}

func superRouteResult(tx *gorm.DB, r superDecisionRow) (SuperRouteResult, error) {
	out := SuperRouteResult{DecisionID: r.ID, TaskID: r.TaskID, Action: r.Action}
	if r.TaskID != "" {
		var w superWorkerRow
		if err := tx.Where("task_id = ? AND parent_worker_id = ''", r.TaskID).First(&w).Error; err != nil {
			return out, err
		}
		out.WorkerID, out.SessionID = w.ID, w.SessionID
	}
	return out, nil
}

// ApplySuperDecision atomically commits routing metadata and a task proposal.
// It has no model/tool loop and never issues a resource permit.
func (e *Engine) ApplySuperDecision(ctx context.Context, b SuperSourceBinding, in SuperDecision) (SuperRouteResult, error) {
	var out SuperRouteResult
	if !b.valid() || in.EventID == "" || in.PartKey == "" || len(in.PartKey) > 128 || in.Reason == "" || len(in.Reason) > 2048 || len(in.Title) > 1000 || len(in.RoleKey) > 128 {
		return out, errSuperBinding
	}
	switch in.Action {
	case "create", "followup", "context_only", "stop", "ask", "respond":
	default:
		return out, errSuperBinding
	}
	if err := e.checkSuperPayload(js(in)); err != nil {
		return out, err
	}
	db, err := e.superStore()
	if err != nil {
		return out, err
	}
	requestHash := hash(js(in))
	err = db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var source superSourceRow
		if err := tx.First(&source, "id = ?", b.SourceID).Error; err != nil {
			return err
		}
		if !superSourceMatches(source, b) {
			return errSuperBinding
		}
		var event superEventRow
		if err := tx.First(&event, "id = ? AND source_id = ? AND project_id = ? AND source_revision = ?", in.EventID, b.SourceID, b.ProjectID, b.Revision).Error; err != nil {
			return err
		}
		var prior superDecisionRow
		lookup := tx.First(&prior, "event_id = ? AND part_key = ? AND revision = ?", event.ID, in.PartKey, 1).Error
		if lookup == nil {
			if prior.RequestHash != requestHash {
				return errSuperConflict
			}
			var err error
			out, err = superRouteResult(tx, prior)
			return err
		}
		if !errors.Is(lookup, gorm.ErrRecordNotFound) {
			return lookup
		}
		if event.Disposition != "pending" {
			return errSuperConflict
		}
		if source.Kind != "user" && in.Action != "context_only" && in.Action != "ask" {
			return errSuperBinding
		}
		if (in.Action == "create" || in.Action == "followup" || in.Action == "stop") && (strings.TrimSpace(in.Quote) == "" || !strings.Contains(event.Payload, in.Quote)) {
			return errSuperBinding
		}
		var priorParts []superDecisionRow
		if err := tx.Where("event_id = ?", event.ID).Find(&priorParts).Error; err != nil {
			return err
		}
		if len(priorParts) >= 16 {
			return errors.New("superagent: event part limit exceeded")
		}
		for _, part := range priorParts {
			if part.Action == in.Action && part.Quote == in.Quote && (in.Action == "create" || part.TaskID == in.TaskID) {
				var err error
				out, err = superRouteResult(tx, part)
				return err
			}
			if in.Action == "create" && part.Action == "create" {
				start, oldStart := strings.Index(event.Payload, in.Quote), strings.Index(event.Payload, part.Quote)
				if start < oldStart+len(part.Quote) && oldStart < start+len(in.Quote) {
					return errors.New("superagent: overlapping requirements need clarification")
				}
			}
		}
		row := superDecisionRow{ID: uid(), EventID: event.ID, PartKey: in.PartKey, Revision: 1, TaskID: in.TaskID, Action: in.Action, Reason: in.Reason, RequestHash: requestHash, Quote: in.Quote, Title: in.Title, RoleKey: in.RoleKey, At: time.Now().UTC()}
		switch in.Action {
		case "create":
			if in.TaskID != "" || strings.TrimSpace(in.Title) == "" || strings.TrimSpace(in.RoleKey) == "" {
				return errSuperBinding
			}
			key := hash(js([]any{event.ID, in.PartKey}))[:32]
			sessionID, taskID, workerID := "sw_"+key, "st_"+key, "worker_"+key
			root := "super_" + key
			g := WorkGoal{ID: taskID, SessionID: sessionID, OriginRootTurnID: root, UserText: event.Payload, Title: in.Title, Status: "running", RoundLimit: 500, DeadlineAt: time.Now().UTC().Add(24 * time.Hour)}
			native := nativeWorkGoal{ID: taskID, SessionID: sessionID, RootTurnID: root, OriginMessageID: event.SourceEventID}
			if err := writeWorkGoalTx(tx, &native, &g, true); err != nil {
				return err
			}
			roleID := hash(js([]any{b.ProjectID, in.RoleKey}))
			var role superRoleRow
			lookup := tx.First(&role, "id = ?", roleID).Error
			if errors.Is(lookup, gorm.ErrRecordNotFound) {
				role = superRoleRow{ID: roleID, ProjectID: b.ProjectID, RoleKey: in.RoleKey, Name: in.RoleKey, Revision: 1}
				if err := tx.Create(&role).Error; err != nil {
					return err
				}
			} else if lookup != nil {
				return lookup
			}
			w := superWorkerRow{ID: workerID, TaskID: taskID, ProjectID: b.ProjectID, SessionID: sessionID, RoleID: roleID, SourceEventID: event.ID, OriginRootTurnID: root, Revision: 1, CreatedAt: row.At}
			if err := tx.Create(&w).Error; err != nil {
				return err
			}
			if err := tx.Create(&superAssignmentRow{ID: "assignment_" + key, WorkerID: workerID, ProjectID: b.ProjectID, State: "queued", CreatedAt: row.At}).Error; err != nil {
				return err
			}
			row.TaskID = taskID
		case "followup", "context_only", "stop":
			var w superWorkerRow
			if err := tx.First(&w, "task_id = ? AND project_id = ? AND parent_worker_id = ''", in.TaskID, b.ProjectID).Error; err != nil {
				return err
			}
			mode := "context_only"
			if in.Action != "context_only" {
				mode = "followup"
			}
			if _, err := enqueueSuperInput(tx, b.ProjectID, event, w.ID, in.PartKey, mode); err != nil {
				return err
			}
		case "ask", "respond":
			if in.TaskID != "" {
				return errSuperBinding
			}
		}
		if err := tx.Create(&row).Error; err != nil {
			return err
		}
		var err error
		out, err = superRouteResult(tx, row)
		return err
	})
	return out, err
}

func (e *Engine) RunPilotRouter(ctx context.Context, sessionID string, b SuperSourceBinding) error {
	if !b.valid() {
		return errSuperBinding
	}
	lock, _ := e.superRouterLocks.LoadOrStore(b.ProjectID, &sync.Mutex{})
	mu := lock.(*sync.Mutex)
	mu.Lock()
	defer mu.Unlock()
	s, err := e.get(sessionID)
	if err != nil {
		return err
	}
	s.mu.Lock()
	c := s.state.Config
	s.mu.Unlock()
	if configSecurityProject(c) != b.ProjectID {
		return errSuperBinding
	}
	events, err := e.PendingSuperEvents(ctx, b, 16)
	if err != nil {
		return err
	}
	if len(events) == 0 {
		return nil
	}
	remaining := []SuperEvent{}
	for _, event := range events {
		routed, err := e.RouteSubscribedEvent(ctx, b.ProjectID, event.ID)
		if err != nil {
			return err
		}
		if len(routed) == 0 {
			remaining = append(remaining, event)
		}
	}
	if len(remaining) == 0 {
		return nil
	}
	run := &superRouterRun{projectID: b.ProjectID, binding: b, events: map[string]bool{}, remaining: 16}
	for _, event := range remaining {
		run.events[event.ID] = true
	}
	c.superRole, c.superTaskID, c.superRouter = "router", "", run
	c.sre, c.sreCoordinator, c.workflowMode, c.legacyInvestigations = nil, false, false, false
	c.Profile = "core"
	c.MaxSteps = min(c.MaxSteps, 16)
	if c.MaxSteps < 1 {
		c.MaxSteps = 16
	}
	if err = e.Configure(sessionID, c); err != nil {
		return err
	}
	defer func() { s.mu.Lock(); s.state.Config.superRouter = nil; s.mu.Unlock() }()
	contextText, err := e.BuildRouterContext(ctx, sessionID, remaining)
	if err != nil {
		return err
	}
	latest := remaining[len(remaining)-1]
	if err = e.ExecuteTurn(ctx, sessionID, TurnInput{UserText: latest.Payload, Context: contextText, StrategyMessageID: latest.SourceEventID}); err != nil {
		return err
	}
	for _, event := range remaining {
		if err = e.finishSuperRouting(ctx, b, event.ID); err != nil {
			return err
		}
	}
	return nil
}

func (e *Engine) finishSuperRouting(ctx context.Context, b SuperSourceBinding, eventID string) error {
	db, err := e.superStore()
	if err != nil {
		return err
	}
	return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var event superEventRow
		if err := tx.First(&event, "id = ? AND source_id = ? AND project_id = ? AND source_revision = ?", eventID, b.SourceID, b.ProjectID, b.Revision).Error; err != nil {
			return err
		}
		var count int64
		if err := tx.Model(&superDecisionRow{}).Where("event_id = ?", eventID).Count(&count).Error; err != nil {
			return err
		}
		if count == 0 {
			if err := tx.Create(&superDecisionRow{ID: uid(), EventID: eventID, PartKey: "direct-response", Revision: 1, Action: "respond", Reason: "Router completed a direct text response", At: time.Now().UTC()}).Error; err != nil {
				return err
			}
		}
		return tx.Model(&superEventRow{}).Where("id = ?", eventID).Update("disposition", "routed").Error
	})
}
