package store

import (
	"context"
	"encoding/json"
	"errors"
)

func (s *Store) ListWorkflowHistory(ctx context.Context, workflowID, excludeRunID string, limit int) ([]WorkflowRun, error) {
	if limit < 1 || limit > 5 {
		limit = 5
	}
	rows, err := s.db.QueryContext(ctx, `SELECT id FROM ops_workflow_run WHERE workflow_id=? AND id<>? AND status IN ('completed','failed','interrupted') ORDER BY created_at DESC,rowid DESC LIMIT ?`, workflowID, excludeRunID, limit)
	if err != nil {
		return nil, err
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	runs := make([]WorkflowRun, 0, len(ids))
	for _, id := range ids {
		run, err := s.GetWorkflowRun(ctx, id)
		if err != nil {
			return nil, err
		}
		runs = append(runs, run)
	}
	return runs, nil
}

// Planning is committed together with its event, before any step starts.
// Resume cannot use this to rewrite an already executing/settled plan.
func (s *Store) SavePendingWorkflowPlan(ctx context.Context, runID string, spec, review json.RawMessage) error {
	if len(spec) == 0 || len(spec) > 64*1024 || !json.Valid(spec) || len(review) == 0 || len(review) > 32*1024 || !json.Valid(review) {
		return errors.New("工作流计划无效或过长")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, `UPDATE ops_workflow_run SET spec=? WHERE id=? AND status='running' AND NOT EXISTS(SELECT 1 FROM ops_workflow_step_run WHERE run_id=? AND status<>'pending') AND NOT EXISTS(SELECT 1 FROM ops_workflow_event WHERE run_id=? AND status='planned')`, string(spec), runID, runID, runID)
	if err != nil {
		return err
	}
	if n, _ := result.RowsAffected(); n != 1 {
		return errors.New("步骤已开始或计划已确定，不能改写运行计划")
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO ops_workflow_event(run_id,status,message,ts) VALUES(?,'planned',?,?)`, runID, string(review), nowMillis()); err != nil {
		return err
	}
	return tx.Commit()
}
