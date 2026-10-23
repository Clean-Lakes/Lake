package ai

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func (e *Engine) NeedsADKRecovery(id string) bool {
	s, err := e.get(id)
	if err != nil {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cancel == nil && s.state.Runtime != nil && len(s.state.View.PendingApprovals) > 0
}

// resumeNativeApproval reconstructs the official Runner from durable state. It
// does not create a new user turn or re-run the original user request.
func (e *Engine) resumeNativeApproval(ctx context.Context, s *session, c Config, cancel context.CancelFunc) (err error) {
	s.mu.Lock()
	firstCard := len(s.state.View.Cards)
	archiveProposedPlan(s)
	s.state.View.ProposedPlan = nil
	s.mu.Unlock()
	if c.ConversationMode == ModePlan {
		c.StrategyCorrectEnabled = false
		c.StrategyLearnEnabled = false
		c.MemoryExtractionEnabled = false
	}
	defer func() {
		if persistErr := e.persistNativeProjection(context.WithoutCancel(ctx), s); persistErr != nil && err == nil {
			err = persistErr
		}
		s.mu.Lock()
		s.finalizing = false
		s.cancel = nil
		e.notify(s, "done", map[string]any{"status": s.state.View.Status, "recovered": true})
		s.mu.Unlock()
	}()
	err = e.runOfficialADK(ctx, s, &c, false, cancel)
	cancel()
	s.mu.Lock()
	defer s.mu.Unlock()
	s.finalizing = true
	status := "completed"
	if err != nil {
		status = "failed"
		if errors.Is(err, context.Canceled) {
			status = "cancelled"
		}
		reconcile(&s.state, "ADK recovery interrupted; no replay")
		s.state.View.Cards = append(s.state.View.Cards, Card{ID: uid(), Type: "error", Content: redact(err.Error(), c), Status: status, At: timestamp()})
	}
	s.decision = nil
	s.decisions = nil
	s.state.View.Pending = nil
	s.state.View.PendingApprovals = nil
	s.state.View.Question = nil
	s.state.View.Status = status
	s.state.View.TurnFinishedAt = timestamp()
	if err == nil && c.ConversationMode == ModePlan {
		captureProposedPlan(s, firstCard)
	}
	for i := range s.state.View.Cards {
		card := &s.state.View.Cards[i]
		if card.Status == "running" || card.Status == "pending" {
			card.Status = status
		}
	}
	if saveErr := e.save(s); saveErr != nil {
		status = "failed"
		s.state.View.Status = status
	}
	return err
}

// Recovery is selected from server-owned role and attempt records only.
type sreRoleRecoveryKey struct{}
type sreRoleRecovery struct{ runID string }

func (e *Engine) hasRecoverableRole(parentID, runID string) bool {
	if !identifier.MatchString(parentID) || !identifier.MatchString(runID) {
		return false
	}
	raw, err := os.ReadFile(filepath.Join(e.Dir, "children", parentID, runID+".json"))
	var state State
	return err == nil && json.Unmarshal(raw, &state) == nil && state.Runtime != nil && (len(state.View.PendingApprovals) > 0 || nativeQuestionReady(state.View.Question))
}

func (e *Engine) recoverAgentDecision(parentID, runID, approval string, accept bool, confirmation string) error {
	s, err := e.get(parentID)
	if err != nil {
		return err
	}
	s.mu.Lock()
	var run AgentRun
	for _, candidate := range s.state.View.AgentRuns {
		if candidate.ID == runID && candidate.SessionID == parentID {
			run = candidate
			break
		}
	}
	s.mu.Unlock()
	if run.SRETaskID == "" || run.Pending == nil || run.Pending.ID != approval || !strings.HasPrefix(approval, "adk-") || !e.hasRecoverableRole(parentID, runID) {
		return errors.New("子任务不存在、已结束或不属于此会话")
	}
	if accept && run.Pending.Confirmation != "" && confirmation != run.Pending.Confirmation {
		return errors.New("explicit target confirmation required")
	}
	store, err := e.adkStore()
	if err != nil {
		return err
	}
	result := store.DB.Model(&nativeApproval{}).Where("id = ? AND session_id = ? AND status = ? AND expires_at > ?", approval, runID, "pending", time.Now()).Updates(map[string]any{"status": "decided", "accepted": accept})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return errors.New("approval expired or already decided")
	}
	return e.queueRoleRecovery(parentID, run.SRETaskID, runID)
}

func (e *Engine) queueRoleRecovery(parentID, taskID, roleRunID string) error {
	var role State
	raw, err := os.ReadFile(filepath.Join(e.Dir, "children", parentID, roleRunID+".json"))
	if err != nil || json.Unmarshal(raw, &role) != nil || role.Runtime == nil {
		return errors.New("durable role wait unavailable")
	}
	key := parentID + ":" + taskID
	if _, loaded := e.sreRecoveries.LoadOrStore(key, true); loaded {
		return nil
	}
	_, err = e.sreRepository.MutateSRETask(parentID, taskID, 0, "recovery_requested", func(t *SRETask) error {
		if !SRETaskActive(t.Status) {
			return errors.New("task already ended")
		}
		// The durable role wait can precede its SRE status projection. A crash
		// in that window makes the business run look interrupted. Reconcile
		// the original attempt instead of starting a replacement plan run.
		run, plan := t.ActiveRun(), t.LatestPlan()
		if run == nil || plan == nil || run.PlanRevisionID != plan.ID {
			return errors.New("role wait belongs to an obsolete plan")
		}
		found := false
		for i := range t.Attempts {
			attempt := &t.Attempts[i]
			if attempt.PlanRunID != run.ID || attempt.RoleRunID != roleRunID {
				continue
			}
			identity := role.Runtime.Identity
			if identity.TaskID != taskID || identity.PlanRunID != run.ID || identity.AttemptID != attempt.ID {
				return errors.New("durable role identity differs from current attempt")
			}
			found = true
			if nativeQuestionReady(role.View.Question) {
				attempt.Status = "waiting_input"
			}
			for _, pending := range role.View.PendingApprovals {
				matched := false
				for j := range attempt.Operations {
					op := &attempt.Operations[j]
					if op.Call.ID != pending.Call.ID || op.Digest != hash(pending.Call.Name+pending.Call.Arguments) {
						continue
					}
					switch op.Status {
					case "prepared", "interrupted", "waiting_approval":
						op.Status, op.ApprovalID = "waiting_approval", pending.ID
						attempt.Status = "waiting_approval"
						matched = true
					default:
						return errors.New("approval operation already dispatched or settled; inspect its outcome")
					}
				}
				if !matched {
					return errors.New("approval has no matching recorded operation")
				}
			}
		}
		if !found || !e.hasRecoverableRole(parentID, roleRunID) {
			return errors.New("role wait outside current plan run")
		}
		switch run.Status {
		case "interrupted", "paused", "running", "waiting_approval":
			run.Status = "paused"
			run.FinishedAt = ""
		default:
			return errors.New("role plan run already ended")
		}
		t.Status = "active"
		t.Error = ""
		return nil
	})
	if err != nil {
		e.sreRecoveries.Delete(key)
		return err
	}
	e.runMu.Lock()
	if e.runtimeClosed {
		e.runMu.Unlock()
		e.sreRecoveries.Delete(key)
		return errors.New("runtime closed")
	}
	e.runs.Add(1)
	e.runMu.Unlock()
	go func() {
		defer e.runs.Done()
		defer e.sreRecoveries.Delete(key)
		_ = e.ResumeSRETask(context.Background(), parentID, taskID)
	}()
	return nil
}

func (e *Engine) executeRecoveredRole(ctx context.Context, id string, c Config, cancel context.CancelFunc) error {
	s, err := e.get(id)
	if err != nil {
		return err
	}
	store, err := e.adkStore()
	if err != nil {
		return err
	}
	s.mu.Lock()
	if req := s.state.View.Question; nativeQuestionReady(req) {
		answers := req.Answers
		if answers == nil {
			reply := make(chan map[string][]string, 1)
			s.questionReply = reply
			e.notify(s, "question", req)
			s.mu.Unlock()
			select {
			case answers = <-reply:
			case <-ctx.Done():
				return ctx.Err()
			}
			s.mu.Lock()
		}
		s.mu.Unlock()
		if err = e.runNativeQuestion(ctx, req, answers, c); err != nil {
			return err
		}
		s.mu.Lock()
		if err = prepareQuestionResponse(s, req, answers); err != nil {
			s.mu.Unlock()
			return err
		}
		e.notify(s, "question", nil)
	}
	s.cancel = cancel
	s.decisions = map[string]chan bool{}
	for _, p := range s.state.View.PendingApprovals {
		var record nativeApproval
		if err = store.DB.First(&record, "id = ? AND session_id = ?", p.ID, id).Error; err != nil {
			s.mu.Unlock()
			return err
		}
		channel := make(chan bool, 1)
		s.decisions[p.ID] = channel
		if record.Status == "decided" {
			channel <- record.Accepted
		}
	}
	s.mu.Unlock()
	return e.resumeNativeApproval(ctx, s, c, cancel)
}

func (e *Engine) NeedsRoleRecovery(parentID, runID string) bool {
	if _, err := e.ownedWorker(parentID, runID); err == nil {
		return false
	}
	return e.hasRecoverableRole(parentID, runID)
}

func (e *Engine) NeedsQuestionRecovery(id string) bool {
	s, err := e.get(id)
	if err != nil {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cancel == nil && nativeQuestionReady(s.state.View.Question)
}
