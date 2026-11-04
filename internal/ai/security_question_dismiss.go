package ai

import (
	"errors"
	"strings"
	"time"

	"gorm.io/gorm"
)

// Caller holds s.mu. Obsolete input can be dismissed, never answered or used
// to resume an old SDK checkpoint. Digest tampering remains a rejected answer.
func (e *Engine) obsoleteSecurityQuestionLocked(s *session, req *QuestionRequest) (bool, error) {
	if req == nil || !strings.HasPrefix(req.ID, "security-confirm-") {
		return false, nil
	}
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return false, err
	}
	var row securityConfirmationQuestionRow
	if err := db.First(&row, "question_id = ?", req.ID).Error; errors.Is(err, gorm.ErrRecordNotFound) {
		return true, nil
	} else if err != nil {
		return false, err
	}
	if row.SessionID != s.state.View.Session || row.StoreID != storeID || row.RecoveryEpoch != epoch || row.RootTurnID != s.state.View.RootTurnID || row.ProjectID != configSecurityProject(s.state.Config) || row.SourceMessageID != s.state.SecuritySourceMessageID || row.GoalID != s.state.WorkGoalID || !time.Now().UTC().Before(row.ExpiresAt) || row.Status != "pending" && row.Status != "answered" {
		return true, nil
	}
	var goal nativeWorkGoal
	if err := db.First(&goal, "id = ? AND session_id = ?", row.GoalID, row.SessionID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return true, nil
		}
		return false, err
	}
	return workTerminal(goal.Status), nil
}

// Only retire the prompt journal and UI wait. No operation, approval, contract,
// acceptance, goal or SDK response is created or rewritten by dismissal.
func (e *Engine) dismissQuestionLocked(s *session, req *QuestionRequest, status string) error {
	if req == nil || s.state.View.Question == nil || req.ID != s.state.View.Question.ID {
		return nil
	}
	if strings.HasPrefix(req.ID, "security-confirm-") {
		db, _, _, err := e.securityTaskDB()
		if err != nil {
			return err
		}
		if err := db.Model(&securityConfirmationQuestionRow{}).Where("question_id = ? AND session_id = ? AND status = ?", req.ID, s.state.View.Session, "pending").Updates(map[string]any{"status": status, "revision": gorm.Expr("revision + 1")}).Error; err != nil {
			return err
		}
	}
	s.state.View.Question = nil
	s.questionReply = nil
	if pending := s.state.PendingGoalQuestion; pending != nil && pending.Request.ID == req.ID {
		s.state.PendingGoalQuestion, s.state.PendingGoalIntent = nil, nil
	}
	if s.state.View.Status == "waiting_input" || s.state.View.Status == "waiting_approval" {
		if s.state.View.Pending == nil && len(s.state.View.PendingApprovals) == 0 {
			s.state.View.Status = "idle"
			if s.cancel != nil {
				s.state.View.Status = "running"
			}
		}
	}
	if err := e.save(s); err != nil {
		return err
	}
	e.notify(s, "question", nil)
	e.notify(s, "inputState", map[string]any{"status": s.state.View.Status})
	return nil
}

func noQuestionAnswers(answers map[string][]string) bool {
	for _, values := range answers {
		if len(values) != 0 {
			return false
		}
	}
	return true
}
