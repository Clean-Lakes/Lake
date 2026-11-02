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
	firstCard        int
	readMu           sync.Mutex
	conversationMode string
	readCursors      map[string]int
	readComplete     map[string]bool
	projectID        string
	binding          SuperSourceBinding
	bindings         map[string]SuperSourceBinding
	modes            map[string]string
	limits           map[string]int
	events           map[string]bool
	remaining        int
	workerRoundLimit int
}
type SuperDecision struct {
	conversationMode string
	EventID          string `json:"eventId"`
	PartKey          string `json:"partKey"`
	Action           string `json:"action"`
	TaskID           string `json:"taskId,omitempty"`
	Title            string `json:"title,omitempty"`
	RoleKey          string `json:"roleKey,omitempty"`
	Quote            string `json:"quote,omitempty"`
	Reason           string `json:"reason"`
	roundLimit       int
}
type SuperRouteResult struct {
	Protocol   string `json:"protocol,omitempty"`
	DecisionID string `json:"decisionId"`
	TaskID     string `json:"taskId,omitempty"`
	WorkerID   string `json:"workerId,omitempty"`
	SessionID  string `json:"sessionId,omitempty"`
	Action     string `json:"action"`
	State      string `json:"state,omitempty"`
	Reason     string `json:"reason,omitempty"`
	Summary    string `json:"summary,omitempty"`
}

func superRouteResult(tx *gorm.DB, r superDecisionRow) (SuperRouteResult, error) {
	out := SuperRouteResult{DecisionID: r.ID, TaskID: r.TaskID, Action: r.Action}
	if r.TaskID != "" {
		var w superWorkerRow
		if err := tx.Where("task_id = ? AND parent_worker_id = ''", r.TaskID).First(&w).Error; err != nil {
			return out, err
		}
		out.WorkerID, out.SessionID = w.ID, w.SessionID
		view, err := projectSuperTaskTx(tx, w.goalSession(), w.TaskID)
		if err != nil {
			return out, err
		}
		out.State, out.Reason, out.Summary = view.State, view.Reason, view.Summary
	}
	return out, nil
}

// ApplySuperDecision atomically commits routing metadata and a task proposal.
// It has no model/tool loop and never issues a resource permit.
func (e *Engine) ApplySuperDecision(ctx context.Context, b SuperSourceBinding, in SuperDecision) (SuperRouteResult, error) {
	var out SuperRouteResult
	if !b.valid() {
		return out, errSuperBinding
	}
	if in.EventID == "" || in.PartKey == "" || len(in.PartKey) > 128 || in.Reason == "" || len(in.Reason) > 2048 || len(in.Title) > 1000 || len(in.RoleKey) > 128 {
		return out, errors.New("superagent: invalid route_work arguments: event_id, part_key and reason are required; maximum lengths are part_key=128, reason=2048, title=1000, role_key=128 bytes")
	}
	switch in.Action {
	case "create":
		if in.TaskID != "" {
			return out, errors.New("superagent: route_work create must omit task_id; the host assigns the new task ID")
		}
		if strings.TrimSpace(in.Title) == "" || strings.TrimSpace(in.RoleKey) == "" {
			return out, errors.New("superagent: route_work create requires both title and role_key; supply the specialist role_key and retry the same event_id and part_key")
		}
	case "followup", "context_only", "stop":
		if in.TaskID == "" {
			return out, errors.New("superagent: route_work followup, context_only and stop require an existing task_id from this project")
		}
	case "ask", "respond":
		if in.TaskID != "" {
			return out, errors.New("superagent: route_work ask and respond must omit task_id")
		}
	default:
		return out, errors.New("superagent: route_work action must be create, followup, context_only, stop, ask or respond")
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
			return errors.New("superagent: route_work create, followup and stop require quote to be an exact non-empty substring of the original user event; copy it without paraphrasing")
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
			key := hash(js([]any{event.ID, in.PartKey}))[:32]
			sessionID, taskID, workerID := "sw_"+key, "st_"+key, "worker_"+key
			root := "super_" + key
			limit := in.roundLimit
			if limit < 1 || limit > 500 {
				limit = 500
			}
			g := WorkGoal{ID: taskID, SessionID: sessionID, OriginRootTurnID: root, UserText: event.Payload, Title: in.Title, Status: "running", RoundLimit: limit, DeadlineAt: event.ReceivedAt.Add(24 * time.Hour)}
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
			w := superWorkerRow{ID: workerID, TaskID: taskID, ProjectID: b.ProjectID, SessionID: sessionID, RoleID: roleID, SourceEventID: event.ID, OriginRootTurnID: root, Revision: 1, CreatedAt: row.At, ConversationMode: in.conversationMode}
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
			if in.Action == "stop" {
				break
			}
			if w.Protocol == "workflow" && in.Action == "followup" {
				return errors.New("superagent: saved workflow constraints are frozen; ask for a separate task or send context_only")
			}
			if _, err := enqueueSuperInput(tx, b.ProjectID, event, w.ID, in.PartKey, mode); err != nil {
				return err
			}
		case "ask", "respond":
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
	db, err := e.superStore()
	if err != nil {
		return err
	}
	var source superSourceRow
	if err = db.WithContext(ctx).First(&source, "id = ?", b.SourceID).Error; err != nil {
		return err
	}
	if !superSourceMatches(source, b) {
		return errSuperBinding
	}
	events, err := e.PendingSuperProjectEvents(ctx, b.ProjectID, 16)
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
	if err = e.beginSuperRoutingAttempt(ctx, b.ProjectID, remaining); err != nil {
		return err
	}
	succeeded := false
	defer func() {
		if !succeeded {
			_ = e.failSuperRouting(context.WithoutCancel(ctx), b.ProjectID, remaining)
		}
	}()
	run := &superRouterRun{projectID: b.ProjectID, binding: b, events: map[string]bool{}, remaining: 16, workerRoundLimit: c.MaxSteps, conversationMode: c.ConversationMode, readCursors: map[string]int{}, readComplete: map[string]bool{}}
	run.bindings = map[string]SuperSourceBinding{}
	run.modes = map[string]string{}
	run.limits = map[string]int{}
	for _, event := range remaining {
		run.events[event.ID] = true
		binding, lookupErr := superSourceForEvent(db.WithContext(ctx), event.ID, b.ProjectID)
		if lookupErr != nil {
			return lookupErr
		}
		run.bindings[event.ID] = binding
		if binding.Kind == "user" {
			input, sourceErr := e.resolveSuperInput(ctx, event)
			if sourceErr != nil {
				return sourceErr
			}
			if input.SuperConversationMode != "" && ValidConversationMode(input.SuperConversationMode) {
				run.modes[event.ID] = input.SuperConversationMode
			}
			if input.SuperMaxSteps > 0 {
				run.limits[event.ID] = min(c.MaxSteps, input.SuperMaxSteps)
			}
		}
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
	for _, event := range remaining {
		if run.bindings[event.ID].Kind == "user" {
			latest = event
			break
		}
	}
	input := TurnInput{UserText: latest.Payload, StrategyMessageID: latest.SourceEventID}
	if run.bindings[latest.ID].Kind == "user" {
		input, err = e.resolveSuperInput(ctx, latest)
		if err != nil {
			return err
		}
	} else {
		input.IgnoreProjectMemory = true
	}
	input.Context = contextText + "\n" + input.Context
	before, snapshotErr := e.Snapshot(sessionID)
	if snapshotErr != nil {
		return snapshotErr
	}
	run.firstCard = before.TotalCards
	invoke, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	if err = e.ExecuteTurn(invoke, sessionID, input); err != nil {
		return err
	}
	err = e.finalizeSuperRouter(ctx, sessionID, run, remaining)
	succeeded = err == nil
	return err
}

func (e *Engine) finishSuperRouting(ctx context.Context, b SuperSourceBinding, eventID string) error {
	db, err := e.superStore()
	if err != nil {
		return err
	}
	return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		return finishSuperRoutingTx(tx, b, eventID)
	})
}

func finishSuperRoutingTx(tx *gorm.DB, b SuperSourceBinding, eventID string) error {
	var source superSourceRow
	if err := tx.First(&source, "id = ?", b.SourceID).Error; err != nil {
		return err
	}
	if !superSourceMatches(source, b) {
		return errSuperBinding
	}
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
}

// FinishSuperUserRouting is for a host's explicit task-selection adapter.
// Models cannot call it; their invocation finalizes admitted events as a batch.
func (e *Engine) FinishSuperUserRouting(ctx context.Context, b SuperSourceBinding, eventID string) error {
	if !b.valid() || b.Kind != "user" {
		return errSuperBinding
	}
	return e.finishSuperRouting(ctx, b, eventID)
}
