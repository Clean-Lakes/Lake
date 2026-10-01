package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

type WorkflowDefinition struct {
	ID          string          `json:"id"`
	LakeID      string          `json:"lake_id"`
	Lake        string          `json:"lake"`
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Spec        json.RawMessage `json:"spec"`
	Enabled     bool            `json:"enabled"`
	CreatedAt   time.Time       `json:"created_at"`
	UpdatedAt   time.Time       `json:"updated_at"`
}

const workflowSelect = `SELECT w.id,w.lake_id,l.name,w.name,w.description,w.spec,w.enabled,w.created_at,w.updated_at FROM ops_workflow w JOIN lake l ON l.id=w.lake_id`

func scanWorkflow(row scanner) (WorkflowDefinition, error) {
	var w WorkflowDefinition
	var raw string
	var enabled int
	var created, updated int64
	err := row.Scan(&w.ID, &w.LakeID, &w.Lake, &w.Name, &w.Description, &raw, &enabled, &created, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return w, ErrNotFound
	}
	if err != nil {
		return w, err
	}
	w.Spec, w.Enabled = json.RawMessage(raw), enabled == 1
	w.CreatedAt, w.UpdatedAt = fromMillis(created), fromMillis(updated)
	return w, nil
}

func (s *Store) CreateWorkflow(ctx context.Context, lakeName, name, description string, spec json.RawMessage) (WorkflowDefinition, error) {
	if err := validName(name); err != nil {
		return WorkflowDefinition{}, err
	}
	if len(spec) == 0 || len(spec) > 64*1024 || !json.Valid(spec) {
		return WorkflowDefinition{}, errors.New("工作流定义不是有效 JSON 或过长")
	}
	lake, err := s.GetLakeByName(ctx, lakeName)
	if err != nil {
		return WorkflowDefinition{}, err
	}
	id, err := newID()
	if err != nil {
		return WorkflowDefinition{}, err
	}
	now := nowMillis()
	_, err = s.db.ExecContext(ctx, `INSERT INTO ops_workflow(id,lake_id,name,description,spec,enabled,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)`, id, lake.ID, name, description, string(spec), now, now)
	if err != nil {
		return WorkflowDefinition{}, fmt.Errorf("保存工作流: %w", err)
	}
	return s.GetWorkflow(ctx, id)
}

// UpdateWorkflow replaces the saved definition for future runs. Existing run
// snapshots remain unchanged.
func (s *Store) UpdateWorkflow(ctx context.Context, id, name, description string, spec json.RawMessage) (WorkflowDefinition, error) {
	if err := validName(name); err != nil {
		return WorkflowDefinition{}, err
	}
	if len(spec) == 0 || len(spec) > 64*1024 || !json.Valid(spec) {
		return WorkflowDefinition{}, errors.New("工作流定义不是有效 JSON 或过长")
	}
	result, err := s.db.ExecContext(ctx, `UPDATE ops_workflow SET name=?,description=?,spec=?,updated_at=? WHERE id=?`, name, description, string(spec), nowMillis(), id)
	if err != nil {
		return WorkflowDefinition{}, fmt.Errorf("更新工作流: %w", err)
	}
	if n, _ := result.RowsAffected(); n == 0 {
		return WorkflowDefinition{}, ErrNotFound
	}
	return s.GetWorkflow(ctx, id)
}

func (s *Store) GetWorkflow(ctx context.Context, id string) (WorkflowDefinition, error) {
	return scanWorkflow(s.db.QueryRowContext(ctx, workflowSelect+` WHERE w.id=?`, id))
}

func (s *Store) ResolveWorkflow(ctx context.Context, lakeName, name string) (WorkflowDefinition, error) {
	return scanWorkflow(s.db.QueryRowContext(ctx, workflowSelect+` WHERE l.name=? AND w.name=?`, lakeName, name))
}

func (s *Store) ListWorkflows(ctx context.Context, lakeName string) ([]WorkflowDefinition, error) {
	query := workflowSelect
	var args []any
	if lakeName != "" {
		query += ` WHERE l.name=?`
		args = append(args, lakeName)
	}
	query += ` ORDER BY l.name,w.name`
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]WorkflowDefinition, 0)
	for rows.Next() {
		item, err := scanWorkflow(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func (s *Store) SetWorkflowEnabled(ctx context.Context, id string, enabled bool) (WorkflowDefinition, error) {
	value := 0
	if enabled {
		value = 1
	}
	result, err := s.db.ExecContext(ctx, `UPDATE ops_workflow SET enabled=?,updated_at=? WHERE id=?`, value, nowMillis(), id)
	if err != nil {
		return WorkflowDefinition{}, err
	}
	if n, _ := result.RowsAffected(); n == 0 {
		return WorkflowDefinition{}, ErrNotFound
	}
	return s.GetWorkflow(ctx, id)
}
