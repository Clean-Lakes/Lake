package ai

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	adksession "google.golang.org/adk/v2/session"
	"google.golang.org/genai"
	"gorm.io/gorm"
)

// Only the authenticated human-input handlers create this checkpoint. It is
// not an event, a new user turn, an execution grant, or a replacement operation.
type superHumanCheckpoint struct {
	RootTurnID, RuntimeID string
	Question              *QuestionRequest
	Answers               map[string][]string
	ApprovalID            string
}

// Called with the original session lock held. Persist the actual answer before
// acknowledging it; the regular host dispatcher supplies fresh configuration
// and resumes only after the old invocation has drained or been fenced.
func (e *Engine) queueSuperHumanRecoveryLocked(s *session, req *QuestionRequest, answers map[string][]string, approvalID string) (bool, error) {
	store, err := e.adkStore()
	if err != nil {
		return false, err
	}
	if !store.DB.Migrator().HasTable(&superWorkerRow{}) {
		return false, nil
	}
	var w superWorkerRow
	err = store.DB.First(&w, "session_id = ?", s.state.View.Session).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return false, nil
	}
	if err != nil {
		return true, err
	}
	if w.ParentWorkerID != "" || w.Protocol == "workflow" {
		return true, errors.New("superagent: original parent graph is required to recover this human input")
	}
	if s.state.Runtime == nil || s.cancel != nil {
		return true, errSuperBinding
	}
	cp := superHumanCheckpoint{RootTurnID: s.state.View.RootTurnID, RuntimeID: s.state.Runtime.SessionID, Question: req, Answers: answers, ApprovalID: approvalID}
	raw := js(cp)
	if err := e.checkSuperPayload(raw); err != nil {
		return true, err
	}
	err = store.DB.Transaction(func(tx *gorm.DB) error {
		_, goal, err := loadSuperGoalTx(tx, w)
		if err != nil {
			return err
		}
		if workTerminal(goal.Status) || !goal.DeadlineAt.After(time.Now().UTC()) || goal.ModelRounds >= goal.RoundLimit {
			return errors.New("superagent: original task cannot resume within its remaining limits")
		}
		var a superAssignmentRow
		if err := tx.First(&a, "worker_id = ?", w.ID).Error; err != nil {
			return err
		}
		if a.Checkpoint != "" && a.Checkpoint != raw {
			var prior superHumanCheckpoint
			if json.Unmarshal([]byte(a.Checkpoint), &prior) != nil || cp.Question != nil || prior.Question != nil || cp.ApprovalID == "" || prior.ApprovalID == "" || cp.RuntimeID != prior.RuntimeID || cp.RootTurnID != prior.RootTurnID {
				return errSuperConflict
			}
			// Other approvals in this exact batch have their own durable native
			// decisions. Keep one resume receipt rather than reject an accepted
			// second decision or start another invocation.
			raw = a.Checkpoint
		}
		updates := map[string]any{"checkpoint": raw}
		switch a.State {
		case "parked", "queued":
			updates["state"], updates["invocation_kind"] = "queued", "human_recovery"
		case "active", "waiting_user": // Wait for explicit expired-owner recovery.
		default:
			return ErrSuperWorkerQueued
		}
		return tx.Model(&superAssignmentRow{}).Where("id = ? AND generation = ?", a.ID, a.Generation).Updates(updates).Error
	})
	return true, err
}

func (e *Engine) resumeSuperHumanWait(ctx context.Context, w superWorkerRow, a superAssignmentRow) error {
	var cp superHumanCheckpoint
	if json.Unmarshal([]byte(a.Checkpoint), &cp) != nil || cp.RuntimeID == "" || cp.RootTurnID == "" || (cp.Question == nil) == (cp.ApprovalID == "") {
		return errSuperBinding
	}
	token, err := e.AcquireWorkerSlot(ctx, w.ProjectID, w.ID)
	if err != nil {
		return err
	}
	run, release := e.beginSuperInvocation(ctx, token)
	defer release()
	s, err := e.get(w.SessionID)
	if err != nil {
		return err
	}
	store, err := e.adkStore()
	if err != nil {
		return err
	}
	s.mu.Lock()
	if s.cancel != nil || s.state.Runtime == nil || s.state.Runtime.SessionID != cp.RuntimeID || s.state.View.RootTurnID != cp.RootTurnID {
		s.mu.Unlock()
		return errSuperConflict
	}
	c := s.state.Config
	c.superAssignment = &token
	s.state.Config.superAssignment = &token
	if cp.Question != nil {
		if !nativeQuestionReady(cp.Question) || cp.Answers == nil {
			s.mu.Unlock()
			return errSuperBinding
		}
		// An accepted main-runner response may have performed more work before
		// a crash. Never resend it just because the host ACK was lost.
		got, lookup := store.Sessions.Get(run, &adksession.GetRequest{AppName: "lake", UserID: "lake", SessionID: cp.RuntimeID})
		if lookup != nil {
			s.mu.Unlock()
			return lookup
		}
		for event := range got.Session.Events().All() {
			if event.Partial || event.Content == nil {
				continue
			}
			for _, part := range event.Content.Parts {
				if part.FunctionResponse != nil && part.FunctionResponse.ID == cp.Question.Call.ID {
					s.mu.Unlock()
					return errors.New("superagent: original human response was already accepted; reconcile its recorded outcome before continuing")
				}
			}
		}
		if err = e.runNativeQuestion(run, cp.Question, cp.Answers, c); err == nil {
			err = prepareQuestionResponse(s, cp.Question, cp.Answers)
			if err != nil { // Cache can already contain the exact paired result.
				for _, message := range s.state.History {
					if message.Role == "tool" && message.CallID == cp.Question.Call.ID && message.Content == js(questionResult(cp.Question.Questions, cp.Answers, false)) {
						s.nativeResumeContent = &genai.Content{Role: "user", Parts: []*genai.Part{{FunctionResponse: &genai.FunctionResponse{ID: message.CallID, Name: message.Name, Response: questionResult(cp.Question.Questions, cp.Answers, false)}}}}
						err = nil
					}
				}
			}
		}
	} else {
		s.decisions = map[string]chan bool{}
		for _, pending := range s.state.View.PendingApprovals {
			var record nativeApproval
			if err = store.DB.First(&record, "id = ? AND session_id = ? AND root_turn_id = ? AND runtime_session_id = ?", pending.ID, w.SessionID, cp.RootTurnID, cp.RuntimeID).Error; err != nil {
				break
			}
			channel := make(chan bool, 1)
			s.decisions[pending.ID] = channel
			if record.Status == "decided" {
				channel <- record.Accepted
			}
		}
	}
	if err != nil {
		s.mu.Unlock()
		return err
	}
	work, cancel := context.WithCancel(run)
	s.cancel = cancel
	s.mu.Unlock()
	err = e.resumeNativeApproval(work, s, c, cancel)
	// Retain the checkpoint on failure so no replacement input can silently
	// supersede it. A successful SDK continuation settles this exact receipt.
	if err == nil {
		_ = store.DB.Model(&superAssignmentRow{}).Where("id = ? AND generation = ? AND owner_id = ?", token.AssignmentID, token.Generation, token.OwnerID).Update("checkpoint", "").Error
	}
	return err
}
