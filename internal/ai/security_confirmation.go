package ai

import (
	"context"
	"errors"
	"strings"
	"time"

	"gorm.io/gorm"
)

// A requirement/proposal journal, not an operation or grant ledger. A recorded
// answer cannot authorize I/O. Resource authority still requires its original
// exact native approval and the normal task/policy/owner permit transaction.
type securityConfirmationQuestionRow struct {
	QuestionID                                                     string `gorm:"primaryKey"`
	Kind, StoreID, RecoveryEpoch, ProjectID, SessionID, RootTurnID string
	SourceMessageID, GoalID, CallID, QuestionDigest, Data, Answers string
	Status                                                         string
	Revision                                                       int64
	CreatedAt, ExpiresAt                                           time.Time
}

func (securityConfirmationQuestionRow) TableName() string { return "security_confirmation_questions" }
func securityConfirmationModels() []any                   { return []any{&securityConfirmationQuestionRow{}} }

type securityConfirmationQuestionContext struct {
	Source     *QuestionSource
	Row        securityConfirmationQuestionRow
	QuestionID string
}

func securityQuestionDigest(req *QuestionRequest) string {
	if req.Source == nil {
		return hash(js(req.Questions))
	}
	return hash(js([]any{req.Questions, req.Source}))
}

type securityConfirmationQuestionContextKey struct{}

func withSecurityConfirmationQuestion(ctx context.Context, binding *securityConfirmationQuestionContext) context.Context {
	return context.WithValue(ctx, securityConfirmationQuestionContextKey{}, binding)
}
func hasSecurityConfirmationQuestion(ctx context.Context) bool {
	binding, _ := ctx.Value(securityConfirmationQuestionContextKey{}).(*securityConfirmationQuestionContext)
	return binding != nil
}

func (e *Engine) bindSecurityConfirmationQuestion(ctx context.Context, s *session, req *QuestionRequest) error {
	binding, _ := ctx.Value(securityConfirmationQuestionContextKey{}).(*securityConfirmationQuestionContext)
	if binding == nil {
		return nil
	}
	if binding.Source != nil {
		copy := *binding.Source
		req.Source = &copy
	}
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return err
	}
	row := binding.Row
	if row.Kind != "work_contract" && row.Kind != "task_grant_proposal" && row.Kind != "manual_work_verification" {
		return errSecurityAction
	}
	s.mu.Lock()
	valid := s.state.View.Question == nil && row.SessionID == s.state.View.Session && row.RootTurnID == s.state.View.RootTurnID && row.SourceMessageID != "" && row.SourceMessageID == s.state.SecuritySourceMessageID && row.ProjectID == configSecurityProject(s.state.Config) && row.GoalID == s.state.WorkGoalID
	s.mu.Unlock()
	if !valid || row.CallID == "" || row.Data == "" || !row.ExpiresAt.After(time.Now().UTC()) || row.ExpiresAt.After(time.Now().UTC().Add(15*time.Minute)) {
		return errSecurityAction
	}
	row.QuestionID, row.StoreID, row.RecoveryEpoch = req.ID, storeID, epoch
	row.QuestionDigest, row.Status, row.Revision, row.CreatedAt = securityQuestionDigest(req), "pending", 1, time.Now().UTC()
	err = e.withSecurityDispatchBarrier(func() error {
		return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			var pending int64
			if err := tx.Model(&securityConfirmationQuestionRow{}).Where("session_id = ? AND root_turn_id = ? AND status = ? AND expires_at > ?", row.SessionID, row.RootTurnID, "pending", time.Now().UTC()).Count(&pending).Error; err != nil {
				return err
			}
			if pending != 0 {
				return errors.New("security: answer the original pending confirmation first")
			}
			return tx.Create(&row).Error
		})
	})
	if err == nil {
		binding.Row, binding.QuestionID = row, row.QuestionID
	}
	return err
}

// Caller holds s.mu, after the existing question validator accepts the actual
// host answer. No contract, task, native approval or grant is issued here.
func (e *Engine) commitSecurityConfirmationAnswer(ctx context.Context, s *session, req *QuestionRequest, answers map[string][]string) error {
	if req == nil || !strings.HasPrefix(req.ID, "security-confirm-") {
		return nil
	}
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return err
	}
	if !db.Migrator().HasTable(&securityConfirmationQuestionRow{}) {
		return nil
	}
	return e.withSecurityDispatchBarrier(func() error {
		return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			var row securityConfirmationQuestionRow
			if err := tx.First(&row, "question_id = ?", req.ID).Error; errors.Is(err, gorm.ErrRecordNotFound) {
				return nil
			} else if err != nil {
				return err
			}
			if row.StoreID != storeID || row.RecoveryEpoch != epoch || row.SessionID != s.state.View.Session || row.RootTurnID != s.state.View.RootTurnID || row.ProjectID != configSecurityProject(s.state.Config) || row.SourceMessageID != s.state.SecuritySourceMessageID || row.GoalID != s.state.WorkGoalID || row.QuestionDigest != securityQuestionDigest(req) || !time.Now().UTC().Before(row.ExpiresAt) {
				return errors.New("security: original confirmation question changed or expired")
			}
			encoded := js(answers)
			if row.Status != "pending" {
				if row.Answers == encoded && (row.Status == "answered" || row.Status == "contract_confirmed" || row.Status == "activated" || row.Status == "grant_confirmed" || row.Status == "single_confirmed" || row.Status == "manual_verified" || row.Status == "rejected") {
					return nil
				}
				return errors.New("security: confirmation answer already recorded")
			}
			result := tx.Model(&securityConfirmationQuestionRow{}).Where("question_id = ? AND status = ? AND revision = ?", row.QuestionID, "pending", row.Revision).Updates(map[string]any{"answers": encoded, "status": "answered", "revision": row.Revision + 1})
			if result.Error != nil {
				return result.Error
			}
			if result.RowsAffected != 1 {
				return errors.New("security: confirmation answer conflict")
			}
			return nil
		})
	})
}
