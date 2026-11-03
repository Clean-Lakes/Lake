package ai

import (
	"context"
	"errors"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type superBudgetRow struct {
	TaskID                     string `gorm:"primaryKey"`
	Rounds, Tokens, TokenLimit int
}

func (superBudgetRow) TableName() string { return "superagent_budgets" }

type superModelChargeRow struct {
	ID                string `gorm:"primaryKey"`
	TaskID            string `gorm:"index"`
	AssignmentID      string
	Generation        int64
	Reserved, Charged int
	Settled           bool
	CreatedAt         time.Time
}

func (superModelChargeRow) TableName() string { return "superagent_model_charges" }

var ErrSuperBudget = errors.New("superagent: task model round limit reached")

const superBudgetPauseReason = "model_round_limit"
const SuperBudgetPauseSummary = "本任务已达到模型调用轮数上限，已暂停。原任务、操作和待处理输入已保留。"
const legacySuperTokenPauseReason = "model_budget_exhausted"
const legacySuperTokenPauseSummary = "本任务的剩余执行额度不足，已暂停，尚未取得新的检查结果。原任务、操作和待处理输入已保留；重复询问不会恢复额度，也不会自动重放原操作。"
const superTokenLimitRemovedReason = "token_limit_removed"
const SuperTokenLimitRemovedSummary = "累计 token 上限已取消，历史用量继续累计。任务可接收后续要求，原资源范围、操作记录和验收要求保留。"

// TokenLimit=0 means accounting without a cumulative token ceiling. This
// changes current policy only; spent usage, rounds and original events remain.
func (e *Engine) removeSuperTokenLimits(ctx context.Context, projectID string) error {
	db, err := e.superStore()
	if err != nil {
		return err
	}
	var workers []superWorkerRow
	err = db.WithContext(ctx).Where("project_id = ? AND parent_worker_id = '' AND task_id IN (?) AND (task_id IN (?) OR id IN (?))", projectID, db.Model(&nativeWorkGoal{}).Select("id").Where("status NOT IN ?", []string{"completed", "failed", "cancelled"}), db.Model(&superBudgetRow{}).Select("task_id").Where("token_limit > 0"), db.Model(&superAssignmentRow{}).Select("worker_id").Where("last_error = ?", legacySuperTokenPauseReason)).Find(&workers).Error
	if err != nil {
		return err
	}
	for _, w := range workers {
		if err := db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			var budget superBudgetRow
			if err := tx.First(&budget, "task_id = ?", w.TaskID).Error; err != nil {
				return err
			}
			if err := tx.Model(&budget).Update("token_limit", 0).Error; err != nil {
				return err
			}
			row, goal, err := loadSuperGoalTx(tx, w)
			if err != nil || workTerminal(goal.Status) {
				return err
			}
			var a superAssignmentRow
			err = tx.First(&a, "worker_id = ? AND last_error = ? AND state IN ?", w.ID, legacySuperTokenPauseReason, []string{"parked", "queued"}).Error
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return nil
			}
			if err != nil {
				return err
			}
			if budget.Rounds >= goal.RoundLimit || goal.ModelRounds >= goal.RoundLimit {
				return pauseSuperBudgetTx(tx, w, &row, &goal)
			}
			reason := ""
			if goal.Status == "paused" && goal.Summary == legacySuperTokenPauseSummary {
				goal.Status, goal.Summary = "blocked", SuperTokenLimitRemovedSummary
				reason = superTokenLimitRemovedReason
				if !goal.DeadlineAt.After(time.Now().UTC()) {
					goal.Status, goal.Summary = "paused", "累计 token 上限已取消；本任务期限已到，仍保持暂停，原记录保留。"
					reason = "deadline_exhausted"
				}
				if err := writeWorkGoalTx(tx, &row, &goal, false); err != nil {
					return err
				}
			}
			if err := tx.Model(&superAssignmentRow{}).Where("last_error = ? AND worker_id IN (?)", legacySuperTokenPauseReason, tx.Model(&superWorkerRow{}).Select("id").Where("task_id = ?", w.TaskID)).Update("last_error", reason).Error; err != nil {
				return err
			}
			if reason != "" {
				return queueSuperBudgetNoticeTx(tx, w, goal, superTokenLimitRemovedReason, goal.Summary)
			}
			return nil
		}); err != nil {
			return err
		}
	}
	return nil
}

// Older hosts recorded the rejected reservation only in the durable engine
// projection. Recover that stop once, without retrying a provider or editing
// the old cards, usage, inputs, permissions or operation results.
func (e *Engine) reconcileSuperBudgetPauses(ctx context.Context, projectID string) error {
	if err := e.removeSuperTokenLimits(ctx, projectID); err != nil {
		return err
	}
	db, err := e.superStore()
	if err != nil {
		return err
	}
	var workers []superWorkerRow
	if err = db.WithContext(ctx).Where("project_id = ? AND parent_worker_id = '' AND task_id IN (?) AND task_id IN (?) AND id IN (?)", projectID, db.Model(&superBudgetRow{}).Select("task_id"), db.Model(&nativeWorkGoal{}).Select("id").Where("status IN ?", []string{"blocked", "paused"}), db.Model(&superAssignmentRow{}).Select("worker_id").Where("last_error = '' AND state IN ?", []string{"parked", "queued"})).Find(&workers).Error; err != nil {
		return err
	}
	for _, w := range workers {
		var observed superAssignmentRow
		err := db.WithContext(ctx).First(&observed, "worker_id = ? AND last_error = '' AND state IN ?", w.ID, []string{"parked", "queued"}).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			continue
		}
		if err != nil {
			return err
		}
		if prior, ok := e.superLegacyBudgetChecked.Load(w.ID); ok && prior == observed.Generation {
			continue
		}
		s, err := e.get(w.SessionID)
		if err != nil {
			return err
		}
		s.mu.Lock()
		stopped := s.cancel == nil && s.state.WorkGoalID == w.TaskID && len(s.state.View.Cards) > 0
		if stopped {
			last := s.state.View.Cards[len(s.state.View.Cards)-1]
			stopped = last.Type == "error" && last.Content == ErrSuperBudget.Error()
		}
		s.mu.Unlock()
		if !stopped {
			e.superLegacyBudgetChecked.Store(w.ID, observed.Generation)
			continue
		}
		if err = db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			var a superAssignmentRow
			err := tx.First(&a, "worker_id = ? AND generation = ? AND last_error = '' AND state IN ?", w.ID, observed.Generation, []string{"parked", "queued"}).Error
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return nil
			}
			if err != nil {
				return err
			}
			row, goal, err := loadSuperGoalTx(tx, w)
			if err != nil || workTerminal(goal.Status) {
				return err
			}
			paused, err := superBudgetPausedTx(tx, goal.ID, goal.RoundLimit)
			if err != nil || !paused {
				return err
			}
			if err = pauseSuperBudgetTx(tx, w, &row, &goal); err != nil {
				return err
			}
			return tx.Model(&superAssignmentRow{}).Where("id = ? AND generation = ?", a.ID, a.Generation).Update("state", "parked").Error
		}); err != nil {
			return err
		}
		e.superLegacyBudgetChecked.Store(w.ID, observed.Generation)
	}
	return nil
}

// Cumulative token totals are telemetry. Only the retained round limit gates
// this task-wide counter; context/output and Security limits are independent.
func superBudgetPausedTx(tx *gorm.DB, taskID string, roundLimit int) (bool, error) {
	var budget superBudgetRow
	err := tx.First(&budget, "task_id = ?", taskID).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return budget.Rounds >= roundLimit, nil
}

func pauseSuperBudgetTx(tx *gorm.DB, w superWorkerRow, row *nativeWorkGoal, goal *WorkGoal) error {
	if workTerminal(goal.Status) {
		return nil
	}
	if goal.Status != "paused" || goal.Summary != SuperBudgetPauseSummary {
		goal.Status, goal.Summary = "paused", SuperBudgetPauseSummary
		if err := writeWorkGoalTx(tx, row, goal, false); err != nil {
			return err
		}
	}
	if err := tx.Model(&superAssignmentRow{}).Where("worker_id IN (?)", tx.Model(&superWorkerRow{}).Select("id").Where("task_id = ?", goal.ID)).Update("last_error", superBudgetPauseReason).Error; err != nil {
		return err
	}
	return queueSuperBudgetNoticeTx(tx, w, *goal, superBudgetPauseReason, SuperBudgetPauseSummary)
}

func queueSuperBudgetNoticeTx(tx *gorm.DB, w superWorkerRow, goal WorkGoal, reason, text string) error {
	var domain superProjectRow
	err := tx.First(&domain, "project_id = ?", w.ProjectID).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	view, err := projectSuperTaskTx(tx, goal.SessionID, goal.ID)
	if err != nil {
		return err
	}
	// One durable attention delivery for this stop, not another model dispatch
	// or a replay of the Worker's last pre-tool narration.
	payload := js(map[string]any{"task": view, "text": text})
	return tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&superOutputRow{ID: hash(js([]any{reason, goal.ID})), TaskID: goal.ID, ProjectID: w.ProjectID, ChannelRef: domain.RouterSessionID, SourceMessageID: goal.ID, Kind: "attention", Payload: payload, RequestHash: hash(payload), ReportRevision: view.Revision, State: "pending", CreatedAt: time.Now().UTC()}).Error
}

// A provider dispatch consumes one durable round and reserves tokens before
// sending. The task-wide row is shared by continuations and child specialists.
// A crash or unknown provider usage retains the reservation conservatively.
func (e *Engine) reserveSuperModel(ctx context.Context, model Model, history []Message, tools []Tool) (func(Usage), error) {
	token, ok := ctx.Value(superAssignmentContextKey{}).(SuperAssignmentToken)
	if !ok {
		return func(Usage) {}, nil
	}
	db, err := e.superStore()
	if err != nil {
		return nil, err
	}
	charge := max(1, (historyCost(history)+len(js(tools))+2)/3) + max(1, model.MaxOutput)
	row := superModelChargeRow{ID: uid(), AssignmentID: token.AssignmentID, Generation: token.Generation, Reserved: charge, Charged: charge, CreatedAt: time.Now().UTC()}
	rejected := false
	err = db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := checkSuperAssignmentTx(tx, token); err != nil {
			return err
		}
		var w superWorkerRow
		if err := tx.First(&w, "id = ?", token.WorkerID).Error; err != nil {
			return err
		}
		goalRow, goal, err := loadSuperGoalTx(tx, w)
		if err != nil {
			return err
		}
		if workTerminal(goal.Status) || !goal.DeadlineAt.After(time.Now().UTC()) {
			return errors.New("superagent: task state or deadline prevents provider dispatch")
		}
		var budget superBudgetRow
		err = tx.First(&budget, "task_id = ?", goal.ID).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			budget = superBudgetRow{TaskID: goal.ID, Rounds: goal.ModelRounds}
			if err = tx.Create(&budget).Error; err != nil {
				return err
			}
		} else if err != nil {
			return err
		}
		budget.TokenLimit = 0
		if err := tx.Model(&budget).Update("token_limit", 0).Error; err != nil {
			return err
		}
		paused, err := superBudgetPausedTx(tx, goal.ID, goal.RoundLimit)
		if err != nil {
			return err
		}
		if paused {
			rejected = true
			return pauseSuperBudgetTx(tx, w, &goalRow, &goal)
		}
		budget.Rounds++
		budget.Tokens += charge
		row.TaskID = goal.ID
		if err = tx.Save(&budget).Error; err != nil {
			return err
		}
		return tx.Create(&row).Error
	})
	if err != nil {
		return nil, err
	}
	if rejected {
		return nil, ErrSuperBudget
	}
	return func(usage Usage) {
		if !usage.InputKnown || !usage.OutputKnown {
			return
		}
		_ = db.Transaction(func(tx *gorm.DB) error {
			var saved superModelChargeRow
			if err := tx.First(&saved, "id = ?", row.ID).Error; err != nil {
				return err
			}
			if saved.Settled {
				return nil
			}
			actual := max(0, usage.Input) + max(0, usage.Output)
			if err := tx.Model(&superBudgetRow{}).Where("task_id = ?", row.TaskID).Update("tokens", gorm.Expr("tokens + ?", actual-saved.Charged)).Error; err != nil {
				return err
			}
			return tx.Model(&superModelChargeRow{}).Where("id = ? AND settled = ?", row.ID, false).Updates(map[string]any{"settled": true, "charged": actual}).Error
		})
	}, nil
}
