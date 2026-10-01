package scheduler

import (
	"context"
	"errors"
	"time"

	"github.com/cloudwego/eino/lake/store"
)

type Execute func(context.Context, store.Schedule, store.ScheduleRun) (workflowRunID, status, reason string, err error)
type Runner struct {
	Store       *store.Store
	Owner       string
	Lease       time.Duration
	MaxLateness time.Duration
	Execute     Execute
}

func (r Runner) RunOne(ctx context.Context, now time.Time) (bool, error) {
	if r.Store == nil || r.Owner == "" || r.Execute == nil {
		return false, errors.New("调度器配置不完整")
	}
	lease := r.Lease
	if lease == 0 {
		lease = 2 * time.Minute
	}
	lateness := r.MaxLateness
	if lateness == 0 {
		lateness = 10 * time.Minute
	}
	if _, err := r.Store.MarkExpiredScheduleRuns(ctx, now); err != nil {
		return false, err
	}
	item, run, err := r.Store.ClaimDueSchedule(ctx, r.Owner, now, lease, func(schedule store.Schedule) (*time.Time, error) {
		if schedule.Kind == "once" {
			return nil, nil
		}
		plan, err := Parse(schedule.Kind, schedule.Expression, schedule.Timezone)
		if err != nil {
			return nil, err
		}
		next, err := plan.Next(*schedule.NextAt)
		if err != nil {
			return nil, err
		}
		return &next, nil
	})
	if errors.Is(err, store.ErrNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if now.Sub(run.DueAt) > lateness {
		return true, r.Store.FinishScheduleRun(ctx, run.ID, r.Owner, "missed", "", "past_due", now)
	}
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		ticker := time.NewTicker(lease / 3)
		defer ticker.Stop()
		for {
			select {
			case <-runCtx.Done():
				return
			case at := <-ticker.C:
				if err := r.Store.RenewScheduleLease(runCtx, item.ID, r.Owner, at, lease); err != nil {
					cancel()
					return
				}
			}
		}
	}()
	workflowRunID, status, reason, executeErr := r.Execute(runCtx, item, run)
	cancel()
	<-stopped
	if executeErr != nil {
		status, reason = "failed", "execution_error"
	}
	if status == "" {
		status, reason = "failed", "invalid_result"
	}
	finishCtx, finishCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer finishCancel()
	if err := r.Store.FinishScheduleRun(finishCtx, run.ID, r.Owner, status, workflowRunID, reason, time.Now()); err != nil {
		return true, err
	}
	return true, executeErr
}
