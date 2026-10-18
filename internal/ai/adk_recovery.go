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
	defer func() {
		if persistErr := e.persistNativeProjection(context.WithoutCancel(ctx), s); persistErr != nil && err == nil {
			err = persistErr
		}
	}()
	err = e.runOfficialADK(ctx, s, &c, false, cancel)
	cancel()
	s.mu.Lock()
	defer s.mu.Unlock()
	status := "completed"
	if err != nil {
		status = "failed"
		if errors.Is(err, context.Canceled) {
			status = "cancelled"
		}
		reconcile(&s.state, "ADK recovery interrupted; no replay")
		s.state.View.Cards = append(s.state.View.Cards, Card{ID: uid(), Type: "error", Content: redact(err.Error(), c), Status: status, At: timestamp()})
	}
	s.cancel = nil
	s.decision = nil
	s.decisions = nil
	s.state.View.Pending = nil
	s.state.View.PendingApprovals = nil
	s.state.View.Question = nil
	s.state.View.Status = status
	s.state.View.TurnFinishedAt = timestamp()
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
	e.notify(s, "done", map[string]any{"status": status, "recovered": true})
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
	return err == nil && json.Unmarshal(raw, &state) == nil && state.Runtime != nil && len(state.View.PendingApprovals) > 0
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
	key := parentID + ":" + run.SRETaskID
	if _, loaded := e.sreRecoveries.LoadOrStore(key, true); loaded {
		return nil
	}
	_, err = e.sreRepository.MutateSRETask(parentID, run.SRETaskID, 0, "recovery_requested", func(t *SRETask) error {
		if !SRETaskActive(t.Status) {
			return errors.New("task already ended")
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
		_ = e.ResumeSRETask(context.Background(), parentID, run.SRETaskID)
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
