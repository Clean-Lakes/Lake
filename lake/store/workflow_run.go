package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

type WorkflowRun struct {
	ID         string            `json:"id"`
	WorkflowID string            `json:"workflow_id"`
	LakeID     string            `json:"lake_id"`
	Name       string            `json:"name"`
	Spec       json.RawMessage   `json:"spec"`
	Trigger    string            `json:"trigger"`
	Status     string            `json:"status"`
	Error      string            `json:"error,omitempty"`
	CreatedAt  time.Time         `json:"created_at"`
	StartedAt  *time.Time        `json:"started_at,omitempty"`
	FinishedAt *time.Time        `json:"finished_at,omitempty"`
	Steps      []WorkflowStepRun `json:"steps"`
}

type WorkflowStepRun struct {
	StepID     string     `json:"step_id"`
	Status     string     `json:"status"`
	Stdout     string     `json:"stdout,omitempty"`
	Stderr     string     `json:"stderr,omitempty"`
	Error      string     `json:"error,omitempty"`
	ExitCode   *int       `json:"exit_code,omitempty"`
	StartedAt  *time.Time `json:"started_at,omitempty"`
	FinishedAt *time.Time `json:"finished_at,omitempty"`
}

type WorkflowEvent struct {
	ID        int64     `json:"id"`
	RunID     string    `json:"run_id"`
	StepID    string    `json:"step_id,omitempty"`
	Status    string    `json:"status"`
	Message   string    `json:"message,omitempty"`
	Timestamp time.Time `json:"timestamp"`
}

func (s *Store) CreateWorkflowRun(ctx context.Context, workflowID, trigger string, stepIDs []string) (WorkflowRun, error) {
	return s.CreateWorkflowRunWithSpec(ctx, workflowID, trigger, stepIDs, nil)
}

func (s *Store) CreateWorkflowRunWithSpec(ctx context.Context, workflowID, trigger string, stepIDs []string, spec json.RawMessage) (WorkflowRun, error) {
	if trigger != "agent" && trigger != "cli" && trigger != "desktop" && trigger != "schedule" {
		return WorkflowRun{}, errors.New("无效的工作流触发方式")
	}
	if len(stepIDs) == 0 || len(stepIDs) > 32 {
		return WorkflowRun{}, errors.New("工作流步骤数量无效")
	}
	w, err := s.GetWorkflow(ctx, workflowID)
	if err != nil {
		return WorkflowRun{}, err
	}
	if !w.Enabled {
		return WorkflowRun{}, errors.New("工作流已停用")
	}
	if len(spec) == 0 {
		spec = w.Spec
	}
	if len(spec) > 64*1024 || !json.Valid(spec) {
		return WorkflowRun{}, errors.New("工作流运行快照无效")
	}
	id, err := newID()
	if err != nil {
		return WorkflowRun{}, err
	}
	now := nowMillis()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return WorkflowRun{}, err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `INSERT INTO ops_workflow_run(id,workflow_id,lake_id,name,spec,trigger_kind,status,created_at) VALUES(?,?,?,?,?,?,'pending',?)`, id, w.ID, w.LakeID, w.Name, string(spec), trigger, now); err != nil {
		return WorkflowRun{}, err
	}
	seen := map[string]bool{}
	for _, stepID := range stepIDs {
		if stepID == "" || seen[stepID] {
			return WorkflowRun{}, errors.New("工作流步骤 ID 为空或重复")
		}
		seen[stepID] = true
		if _, err := tx.ExecContext(ctx, `INSERT INTO ops_workflow_step_run(run_id,step_id,status) VALUES(?,?,'pending')`, id, stepID); err != nil {
			return WorkflowRun{}, err
		}
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO ops_workflow_event(run_id,status,message,ts) VALUES(?,'pending','created',?)`, id, now); err != nil {
		return WorkflowRun{}, err
	}
	if err := tx.Commit(); err != nil {
		return WorkflowRun{}, err
	}
	return s.GetWorkflowRun(ctx, id)
}

func (s *Store) GetWorkflowRun(ctx context.Context, id string) (WorkflowRun, error) {
	var run WorkflowRun
	var spec string
	var created int64
	var started, finished sql.NullInt64
	err := s.db.QueryRowContext(ctx, `SELECT id,workflow_id,lake_id,name,spec,trigger_kind,status,error,created_at,started_at,finished_at FROM ops_workflow_run WHERE id=?`, id).Scan(&run.ID, &run.WorkflowID, &run.LakeID, &run.Name, &spec, &run.Trigger, &run.Status, &run.Error, &created, &started, &finished)
	if errors.Is(err, sql.ErrNoRows) {
		return run, ErrNotFound
	}
	if err != nil {
		return run, err
	}
	run.Spec = json.RawMessage(spec)
	run.CreatedAt = fromMillis(created)
	if started.Valid {
		value := fromMillis(started.Int64)
		run.StartedAt = &value
	}
	if finished.Valid {
		value := fromMillis(finished.Int64)
		run.FinishedAt = &value
	}
	rows, err := s.db.QueryContext(ctx, `SELECT step_id,status,stdout,stderr,error,exit_code,started_at,finished_at FROM ops_workflow_step_run WHERE run_id=? ORDER BY rowid`, id)
	if err != nil {
		return run, err
	}
	defer rows.Close()
	run.Steps = make([]WorkflowStepRun, 0)
	for rows.Next() {
		var step WorkflowStepRun
		var exit, stepStarted, stepFinished sql.NullInt64
		if err := rows.Scan(&step.StepID, &step.Status, &step.Stdout, &step.Stderr, &step.Error, &exit, &stepStarted, &stepFinished); err != nil {
			return run, err
		}
		if exit.Valid {
			value := int(exit.Int64)
			step.ExitCode = &value
		}
		if stepStarted.Valid {
			value := fromMillis(stepStarted.Int64)
			step.StartedAt = &value
		}
		if stepFinished.Valid {
			value := fromMillis(stepFinished.Int64)
			step.FinishedAt = &value
		}
		run.Steps = append(run.Steps, step)
	}
	return run, rows.Err()
}

func (s *Store) ListWorkflowRuns(ctx context.Context, lakeID string, limit int) ([]WorkflowRun, error) {
	if limit <= 0 || limit > 100 {
		limit = 30
	}
	query := `SELECT id FROM ops_workflow_run`
	args := []any{}
	if lakeID != "" {
		query += ` WHERE lake_id=?`
		args = append(args, lakeID)
	}
	query += ` ORDER BY created_at DESC LIMIT ?`
	args = append(args, limit)
	rows, err := s.db.QueryContext(ctx, query, args...)
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
	out := make([]WorkflowRun, 0, len(ids))
	for _, id := range ids {
		run, err := s.GetWorkflowRun(ctx, id)
		if err != nil {
			return nil, err
		}
		out = append(out, run)
	}
	return out, nil
}

func (s *Store) SetWorkflowRunStatus(ctx context.Context, id, status, message string) error {
	switch status {
	case "running", "completed", "failed", "cancelled", "interrupted":
	default:
		return fmt.Errorf("无效的工作流状态 %q", status)
	}
	if len(message) > 4000 {
		message = message[:4000]
	}
	now := nowMillis()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var result sql.Result
	if status == "running" {
		result, err = tx.ExecContext(ctx, `UPDATE ops_workflow_run SET status='running',started_at=COALESCE(started_at,?),finished_at=NULL,error='' WHERE id=? AND status IN ('pending','interrupted','failed')`, now, id)
	} else {
		result, err = tx.ExecContext(ctx, `UPDATE ops_workflow_run SET status=?,finished_at=?,error=? WHERE id=? AND status='running'`, status, now, message, id)
	}
	if err != nil {
		return err
	}
	if n, _ := result.RowsAffected(); n == 0 {
		return errors.New("工作流状态已变化，无法更新")
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO ops_workflow_event(run_id,status,message,ts) VALUES(?,?,?,?)`, id, status, message, now); err != nil {
		return err
	}
	return tx.Commit()
}

// RecoverWorkflowRun marks a stale in-progress run as interrupted. The caller
// must first establish that its owner process has exited; active SSH commands
// could otherwise still be running on the remote host.
func (s *Store) RecoverWorkflowRun(ctx context.Context, id string) error {
	now := nowMillis()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, `UPDATE ops_workflow_run SET status='interrupted',finished_at=?,error='由用户标记为中断；可能已有远端步骤执行' WHERE id=? AND status='running'`, now, id)
	if err != nil {
		return err
	}
	if n, _ := result.RowsAffected(); n == 0 {
		return errors.New("运行状态不是 running，无法标记中断")
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO ops_workflow_event(run_id,status,message,ts) VALUES(?,'interrupted','manual recovery',?)`, id, now); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) SetWorkflowStepStatus(ctx context.Context, runID, stepID, status, stdout, stderr, message string, exitCode *int) error {
	switch status {
	case "pending", "running", "completed", "failed", "skipped", "unknown", "cancelled":
	default:
		return fmt.Errorf("无效的步骤状态 %q", status)
	}
	if len(stdout) > 16*1024 {
		stdout = stdout[:16*1024] + "\n…已截断"
	}
	if len(stderr) > 16*1024 {
		stderr = stderr[:16*1024] + "\n…已截断"
	}
	if len(message) > 4000 {
		message = message[:4000]
	}
	now := nowMillis()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var result sql.Result
	if status == "running" {
		result, err = tx.ExecContext(ctx, `UPDATE ops_workflow_step_run SET status='running',started_at=?,finished_at=NULL,stdout='',stderr='',error='',exit_code=NULL WHERE run_id=? AND step_id=? AND status IN ('pending','failed','cancelled')`, now, runID, stepID)
	} else if status == "pending" {
		result, err = tx.ExecContext(ctx, `UPDATE ops_workflow_step_run SET status='pending',started_at=NULL,finished_at=NULL,stdout='',stderr='',error='',exit_code=NULL WHERE run_id=? AND step_id=? AND status IN ('unknown','failed','cancelled','completed','skipped')`, runID, stepID)
	} else {
		result, err = tx.ExecContext(ctx, `UPDATE ops_workflow_step_run SET status=?,stdout=?,stderr=?,error=?,exit_code=?,finished_at=? WHERE run_id=? AND step_id=? AND status IN ('pending','running')`, status, stdout, stderr, message, exitCode, now, runID, stepID)
	}
	if err != nil {
		return err
	}
	if n, _ := result.RowsAffected(); n == 0 {
		return errors.New("步骤状态已变化，无法更新")
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO ops_workflow_event(run_id,step_id,status,message,ts) VALUES(?,?,?,?,?)`, runID, stepID, status, message, now); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) ListWorkflowEvents(ctx context.Context, runID string) ([]WorkflowEvent, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id,run_id,step_id,status,message,ts FROM ops_workflow_event WHERE run_id=? ORDER BY id`, runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]WorkflowEvent, 0)
	for rows.Next() {
		var event WorkflowEvent
		var ts int64
		if err := rows.Scan(&event.ID, &event.RunID, &event.StepID, &event.Status, &event.Message, &ts); err != nil {
			return nil, err
		}
		event.Timestamp = fromMillis(ts)
		out = append(out, event)
	}
	return out, rows.Err()
}

// AppendWorkflowStepProgress preserves recovery decisions without changing the
// running step or overwriting a prior attempt's execution history.
func (s *Store) AppendWorkflowStepProgress(ctx context.Context, runID, stepID, message string) error {
	if len(message) > 4000 {
		return errors.New("工作流步骤事件过长")
	}
	result, err := s.db.ExecContext(ctx, `INSERT INTO ops_workflow_event(run_id,step_id,status,message,ts) SELECT run_id,step_id,'running',?,? FROM ops_workflow_step_run WHERE run_id=? AND step_id=? AND status='running'`, message, nowMillis(), runID, stepID)
	if err != nil {
		return err
	}
	if n, _ := result.RowsAffected(); n != 1 {
		return errors.New("步骤未在运行，拒绝记录恢复事件")
	}
	return nil
}
