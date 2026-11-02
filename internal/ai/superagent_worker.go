package ai

import (
	"context"
	"errors"
	"gorm.io/gorm"
)

// Recovery and generic host configuration cannot accidentally turn a persisted
// Worker into a broad ordinary chat or re-enable natural preference inheritance.
func (e *Engine) enforceSuperSessionConfig(sessionID string, c Config) (Config, error) {
	store, err := e.adkStore()
	if err != nil {
		return c, err
	}
	if !store.DB.Migrator().HasTable(&superWorkerRow{}) {
		return c, nil
	}
	var w superWorkerRow
	err = store.DB.First(&w, "session_id = ?", sessionID).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return c, nil
	}
	if err != nil {
		return c, err
	}
	if w.ProjectID != configSecurityProject(c) {
		return c, errSuperBinding
	}
	c.superRole, c.superTaskID, c.superRouter = "worker", w.TaskID, nil
	c.MemoryEnabled, c.MemoryExtractionEnabled, c.IgnoreNaturalMemory = false, false, true
	c.NaturalMemory = nil
	c.sreCoordinator, c.legacyInvestigations = false, false
	return c, nil
}

// bindSuperWorkerProposalLocked preserves the single original proposal while
// keeping the established host confirmation and Security activation path.
func (e *Engine) bindSuperWorkerProposalLocked(ctx context.Context, s *session, c *Config, sourceID string) error {
	db, err := e.superStore()
	if err != nil {
		return err
	}
	var w superWorkerRow
	if err = db.WithContext(ctx).First(&w, "session_id = ? AND task_id = ? AND project_id = ?", s.state.View.Session, c.superTaskID, configSecurityProject(*c)).Error; err != nil {
		return err
	}
	var goal nativeWorkGoal
	if err = db.WithContext(ctx).First(&goal, "id = ? AND session_id = ?", w.TaskID, w.SessionID).Error; err != nil {
		return err
	}
	if workTerminal(goal.Status) {
		return errors.New("superagent: terminal task cannot start a Worker")
	}
	managed, err := e.SecurityProjectManaged(ctx, w.ProjectID)
	if err != nil {
		return err
	}
	if !managed {
		return errors.New("superagent: Worker requires current Security policy")
	}
	if goal.ClosureContract == "" {
		if sourceID != goal.OriginMessageID {
			return errors.New("superagent: original proposal source required")
		}
		s.state.SecurityManaged, s.state.SecurityTaskID, s.state.WorkGoalID, s.state.SecuritySourceMessageID = true, "", goal.ID, sourceID
		c.securityExecution, s.state.Config.securityExecution = nil, nil
	}
	return nil
}

// ConfigureTaskWorker takes a fresh host configuration for this exact internal
// session. It does not copy a Router transcript, credentials or execution owner.
func (e *Engine) ConfigureTaskWorker(ctx context.Context, projectID, workerID string, c Config) error {
	if configSecurityProject(c) != projectID {
		return errSuperBinding
	}
	db, err := e.superStore()
	if err != nil {
		return err
	}
	w, err := superWorkerInProject(db.WithContext(ctx), workerID, projectID)
	if err != nil {
		return err
	}
	c.superRole, c.superTaskID, c.superRouter = "worker", w.TaskID, nil
	c.sre, c.sreCoordinator, c.workflowMode, c.legacyInvestigations = nil, false, false, false
	c.securityExecution = nil
	c.MemoryEnabled, c.MemoryExtractionEnabled, c.IgnoreNaturalMemory = false, false, true
	c.NaturalMemory = nil
	c.Profile = "core"
	return e.Configure(w.SessionID, c)
}

func (e *Engine) StartTaskWorker(ctx context.Context, projectID, workerID string) error {
	db, err := e.superStore()
	if err != nil {
		return err
	}
	w, err := superWorkerInProject(db.WithContext(ctx), workerID, projectID)
	if err != nil {
		return err
	}
	s, err := e.get(w.SessionID)
	if err != nil {
		return err
	}
	s.mu.Lock()
	c := s.state.Config
	s.mu.Unlock()
	if c.superRole != "worker" || c.superTaskID != w.TaskID || configSecurityProject(c) != projectID {
		return errSuperBinding
	}
	var event superEventRow
	if err = db.WithContext(ctx).First(&event, "id = ? AND project_id = ?", w.SourceEventID, projectID).Error; err != nil {
		return err
	}
	var decision superDecisionRow
	if err = db.WithContext(ctx).First(&decision, "task_id = ? AND action = ?", w.TaskID, "create").Error; err != nil {
		return err
	}
	assignment, err := e.AcquireWorkerSlot(ctx, projectID, workerID)
	if err != nil {
		return err
	}
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	done := make(chan struct{})
	go e.heartbeatSuperAssignment(runCtx, assignment, cancel, done)
	defer func() { cancel(); <-done; _ = e.ReleaseWorkerSlot(context.Background(), assignment, "parked") }()
	// Root identity is installed by ExecuteTurn only for this original proposal.
	return e.ExecuteTurn(runCtx, w.SessionID, TurnInput{UserText: event.Payload, StrategyMessageID: event.SourceEventID, Context: "[ASSIGNED DELIVERABLE]\n" + decision.Quote + "\n[BOUNDARY]\nWork only on this quoted deliverable. The original user message is retained for constraints; its other independent deliverables belong to other Workers. Canonical task: " + w.TaskID})
}

func (e *Engine) SuperQueuedWorkers(ctx context.Context, projectID string) ([]SuperRouteResult, error) {
	db, err := e.superStore()
	if err != nil {
		return nil, err
	}
	var rows []superWorkerRow
	err = db.WithContext(ctx).Where("project_id = ? AND id IN (?)", projectID, db.Model(&superAssignmentRow{}).Select("worker_id").Where("state = ?", "queued")).Order("created_at, id").Find(&rows).Error
	out := make([]SuperRouteResult, 0, len(rows))
	for _, w := range rows {
		out = append(out, SuperRouteResult{TaskID: w.TaskID, WorkerID: w.ID, SessionID: w.SessionID})
	}
	return out, err
}
