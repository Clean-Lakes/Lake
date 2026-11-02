package ai

import (
	"context"
	"errors"
	"time"

	"gorm.io/gorm"
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

var ErrSuperBudget = errors.New("superagent: original task's cumulative model budget exhausted")

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
	err = db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := checkSuperAssignmentTx(tx, token); err != nil {
			return err
		}
		var w superWorkerRow
		if err := tx.First(&w, "id = ?", token.WorkerID).Error; err != nil {
			return err
		}
		_, goal, err := loadSuperGoalTx(tx, w)
		if err != nil {
			return err
		}
		if workTerminal(goal.Status) || !goal.DeadlineAt.After(time.Now().UTC()) {
			return ErrSuperBudget
		}
		var budget superBudgetRow
		err = tx.First(&budget, "task_id = ?", goal.ID).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			_, usageLimit := agentUsageLimits(Config{Model: model})
			budget = superBudgetRow{TaskID: goal.ID, Rounds: goal.ModelRounds, TokenLimit: usageLimit}
			if err = tx.Create(&budget).Error; err != nil {
				return err
			}
		} else if err != nil {
			return err
		}
		if budget.Rounds >= goal.RoundLimit || charge > budget.TokenLimit-budget.Tokens {
			return ErrSuperBudget
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
