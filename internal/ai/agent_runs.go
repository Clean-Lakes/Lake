package ai

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type AgentEvidence struct {
	ID              string `json:"id"`
	SessionID       string `json:"sessionId"`
	RunID           string `json:"runId"`
	ResourceID      string `json:"resourceId"`
	ResourceName    string `json:"resourceName,omitempty"`
	AssetRef        string `json:"assetRef,omitempty"`
	Title           string `json:"title"`
	Excerpt         string `json:"excerpt"`
	ExitCode        *int   `json:"exitCode"`
	CollectedAt     string `json:"collectedAt"`
	Success         bool   `json:"success"`
	HasSource       bool   `json:"hasSource,omitempty"`
	SourceBytes     int    `json:"sourceBytes,omitempty"`
	SourceTruncated bool   `json:"sourceTruncated,omitempty"`
}
type AgentRun struct {
	LiveTextID        string           `json:"liveTextId,omitempty"`
	LiveText          string           `json:"liveText,omitempty"`
	Question          *QuestionRequest `json:"question,omitempty"`
	ActivityPhase     string           `json:"activityPhase,omitempty"`
	ActivityTool      string           `json:"activityTool,omitempty"`
	ActivityUpdatedAt string           `json:"activityUpdatedAt,omitempty"`
	SRETaskID         string           `json:"sreTaskId,omitempty"`
	SRERole           SREAgentRole     `json:"sreRole,omitempty"`
	budgetReserved    int
	AutomaticSurvey   bool            `json:"automaticSurvey,omitempty"`
	WorkflowStepID    string          `json:"workflowStepId,omitempty"`
	ID                string          `json:"id"`
	SessionID         string          `json:"sessionId"`
	RootTurnID        string          `json:"rootTurnId"`
	Role              string          `json:"role"`
	Name              string          `json:"name"`
	Task              string          `json:"task"`
	ResourceIDs       []string        `json:"resourceIds"`
	Status            string          `json:"status"`
	Summary           string          `json:"summary,omitempty"`
	Evidence          []AgentEvidence `json:"evidence,omitempty"`
	EvidenceIDs       []string        `json:"evidenceIds,omitempty"`
	ToolCount         int             `json:"toolCount"`
	Usage             Usage           `json:"usage"`
	BudgetSpent       int             `json:"budgetSpent"`
	CreatedAt         string          `json:"createdAt"`
	StartedAt         string          `json:"startedAt,omitempty"`
	FinishedAt        string          `json:"finishedAt,omitempty"`
	CanCancel         bool            `json:"canCancel"`
	Pending           *Approval       `json:"pending,omitempty"`
}
type investigationSpec struct {
	WorkflowStepID string   `json:"-"`
	Role           string   `json:"role"`
	Task           string   `json:"task"`
	AssetRefs      []string `json:"asset_refs,omitempty"`
	Context        string   `json:"context,omitempty"`
}
type agentWorker struct {
	sreTaskID                     string
	sreQuestion                   bool
	parent                        *Engine
	session                       *session
	parentID, runID, turnID, role string
	assets                        []string
	ctx                           context.Context
	cancel                        context.CancelFunc
	done                          chan struct{}
	child                         *Engine
	mu                            sync.Mutex
	calls                         int
	lastModelChars, lastInput     int
	finalizing                    bool
	reads                         map[string]int
	sreObservations               map[string]any
	sreReportAt                   time.Time
}

var agentNames = map[string]string{"host": "Scout", "application": "Trace", "data": "Deep", "verify": "Beacon"}

func agentActive(status string) bool {
	return status == "queued" || status == "running" || status == "waiting_approval" || status == "waiting_input"
}

func (e *Engine) updateAgent(w *agentWorker, update func(*AgentRun)) error {
	w.session.mu.Lock()
	defer w.session.mu.Unlock()
	for i := range w.session.state.View.AgentRuns {
		r := &w.session.state.View.AgentRuns[i]
		if r.ID == w.runID {
			update(r)
			if err := e.save(w.session); err != nil {
				return err
			}
			e.notify(w.session, "agentRun", map[string]any{"runId": r.ID, "status": r.Status})
			return nil
		}
	}
	return errors.New("子任务记录不存在")
}
func (e *Engine) currentInvestigations(s *session) []AgentRun {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []AgentRun{}
	for _, r := range s.state.View.AgentRuns {
		if r.RootTurnID == s.state.View.RootTurnID {
			out = append(out, r)
		}
	}
	b, _ := json.Marshal(out)
	var snapshot []AgentRun
	_ = json.Unmarshal(safeJSON(b, s.state.Config), &snapshot)
	return snapshot
}
func (e *Engine) ownedWorker(parentID, runID string) (*agentWorker, error) {
	e.agentMu.Lock()
	defer e.agentMu.Unlock()
	w := e.agentWorkers[runID]
	if w == nil || w.parentID != parentID {
		return nil, errors.New("子任务不存在、已结束或不属于此会话")
	}
	return w, nil
}
func (e *Engine) CancelAgent(parentID, runID string) error {
	w, err := e.ownedWorker(parentID, runID)
	if err != nil {
		return err
	}
	e.agentMu.Lock()
	w.cancel()
	e.agentMu.Unlock()
	return nil
}
func (e *Engine) AgentDecision(parentID, runID, approval string, accept bool, confirmation string) error {
	w, err := e.ownedWorker(parentID, runID)
	if err != nil {
		return e.recoverAgentDecision(parentID, runID, approval, accept, confirmation)
	}
	return w.child.Decision(runID, approval, accept, confirmation)
}
func (e *Engine) stopAgentWorkers() []<-chan struct{} {
	e.agentMu.Lock()
	defer e.agentMu.Unlock()
	e.agentsClosed = true
	done := []<-chan struct{}{}
	for _, w := range e.agentWorkers {
		w.cancel()
		done = append(done, w.done)
	}
	return done
}

// Child tools register observations in the parent journal, so a model cannot
// invent the evidence ID, target, timestamp, exit code, or ownership.
func (e *Engine) AgentDetails(parentID, runID string) (View, error) {
	s, err := e.get(parentID)
	if err != nil {
		return View{}, err
	}
	s.mu.Lock()
	owned := false
	status, summary := "", ""
	for _, r := range s.state.View.AgentRuns {
		if r.ID == runID && r.SessionID == parentID {
			owned = true
			status, summary = r.Status, r.Summary
		}
	}
	s.mu.Unlock()
	if !owned || !identifier.MatchString(runID) {
		return View{}, errors.New("子任务不属于此会话")
	}
	if w, err := e.ownedWorker(parentID, runID); err == nil {
		return w.child.Snapshot(runID)
	}
	path := filepath.Join(e.Dir, "children", parentID, runID+".json")
	b, err := os.ReadFile(path)
	if err != nil {
		return View{}, err
	}
	var state State
	if json.Unmarshal(b, &state) != nil {
		return View{}, fmt.Errorf("子任务历史无效")
	}
	state.View.Status, state.View.Summary = status, summary
	if !agentActive(status) {
		state.View.Pending = nil
		for i := range state.View.Cards {
			if state.View.Cards[i].Status == "running" || state.View.Cards[i].Status == "pending" {
				state.View.Cards[i].Status = "interrupted"
			}
		}
	}
	return state.View, nil
}
