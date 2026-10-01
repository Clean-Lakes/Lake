package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"
)

type WorkflowV2Definition struct {
	ID          string          `json:"id"`
	LakeID      string          `json:"lake_id"`
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Spec        json.RawMessage `json:"spec"`
	Revision    int             `json:"revision"`
	Enabled     bool            `json:"enabled"`
	CreatedAt   time.Time       `json:"created_at"`
	UpdatedAt   time.Time       `json:"updated_at"`
}

type WorkflowV2Node struct {
	RunID     string          `json:"run_id"`
	NodeID    string          `json:"node_id"`
	Status    string          `json:"status"`
	Input     json.RawMessage `json:"input,omitempty"`
	Approval  json.RawMessage `json:"approval,omitempty"`
	Result    json.RawMessage `json:"result,omitempty"`
	ErrorCode string          `json:"error_code,omitempty"`
	UpdatedAt time.Time       `json:"updated_at"`
}

type WorkflowV2Run struct {
	ID           string           `json:"id"`
	DefinitionID string           `json:"definition_id,omitempty"`
	LakeID       string           `json:"lake_id"`
	Name         string           `json:"name"`
	Revision     int              `json:"revision"`
	Trigger      string           `json:"trigger"`
	Spec         json.RawMessage  `json:"spec"`
	Status       string           `json:"status"`
	Nodes        []WorkflowV2Node `json:"nodes"`
	CreatedAt    time.Time        `json:"created_at"`
	UpdatedAt    time.Time        `json:"updated_at"`
}

type WorkflowV2Event struct {
	RunID     string          `json:"run_id"`
	Sequence  int64           `json:"sequence"`
	NodeID    string          `json:"node_id,omitempty"`
	Kind      string          `json:"kind"`
	Payload   json.RawMessage `json:"payload"`
	CreatedAt time.Time       `json:"created_at"`
}

func (s *Store) CreateWorkflowV2(ctx context.Context, lakeID, name, description string, spec json.RawMessage) (WorkflowV2Definition, error) {
	if err := validName(name); err != nil {
		return WorkflowV2Definition{}, err
	}
	if len(description) > 2000 || len(spec) == 0 || len(spec) > 256*1024 || !json.Valid(spec) {
		return WorkflowV2Definition{}, errors.New("工作流 v2 定义无效")
	}
	id, err := newID()
	if err != nil {
		return WorkflowV2Definition{}, err
	}
	now := nowMillis()
	if _, err = s.db.ExecContext(ctx, `INSERT INTO workflow_v2_definition(id,lake_id,name,description,spec_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`, id, lakeID, name, description, string(spec), now, now); err != nil {
		return WorkflowV2Definition{}, err
	}
	return s.GetWorkflowV2(ctx, id)
}

func (s *Store) UpdateWorkflowV2(ctx context.Context, id, name, description string, spec json.RawMessage) (WorkflowV2Definition, error) {
	if err := validName(name); err != nil {
		return WorkflowV2Definition{}, err
	}
	if len(description) > 2000 || len(spec) == 0 || len(spec) > 256*1024 || !json.Valid(spec) {
		return WorkflowV2Definition{}, errors.New("工作流 v2 定义无效")
	}
	result, err := s.db.ExecContext(ctx, `UPDATE workflow_v2_definition SET name=?,description=?,spec_json=?,revision=revision+1,updated_at=? WHERE id=?`, name, description, string(spec), nowMillis(), id)
	if err != nil {
		return WorkflowV2Definition{}, err
	}
	if n, _ := result.RowsAffected(); n == 0 {
		return WorkflowV2Definition{}, ErrNotFound
	}
	return s.GetWorkflowV2(ctx, id)
}

func scanWorkflowV2(row scanner) (WorkflowV2Definition, error) {
	var item WorkflowV2Definition
	var spec string
	var enabled int
	var created, updated int64
	err := row.Scan(&item.ID, &item.LakeID, &item.Name, &item.Description, &spec, &item.Revision, &enabled, &created, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return item, ErrNotFound
	}
	if err != nil {
		return item, err
	}
	item.Spec = json.RawMessage(spec)
	item.Enabled = enabled == 1
	item.CreatedAt = fromMillis(created)
	item.UpdatedAt = fromMillis(updated)
	return item, nil
}

func (s *Store) GetWorkflowV2(ctx context.Context, id string) (WorkflowV2Definition, error) {
	return scanWorkflowV2(s.db.QueryRowContext(ctx, `SELECT id,lake_id,name,description,spec_json,revision,enabled,created_at,updated_at FROM workflow_v2_definition WHERE id=?`, id))
}

func (s *Store) ListWorkflowsV2(ctx context.Context, lakeID string) ([]WorkflowV2Definition, error) {
	query := `SELECT id,lake_id,name,description,spec_json,revision,enabled,created_at,updated_at FROM workflow_v2_definition`
	var args []any
	if lakeID != "" {
		query += ` WHERE lake_id=?`
		args = append(args, lakeID)
	}
	query += ` ORDER BY name,id`
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]WorkflowV2Definition, 0)
	for rows.Next() {
		item, err := scanWorkflowV2(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func appendWorkflowV2Event(ctx context.Context, tx *sql.Tx, runID, nodeID, kind string, payload json.RawMessage) error {
	if len(payload) == 0 {
		payload = json.RawMessage(`{}`)
	}
	if len(payload) > 4096 || !json.Valid(payload) {
		return errors.New("工作流 v2 事件摘要无效")
	}
	_, err := tx.ExecContext(ctx, `INSERT INTO workflow_v2_event(run_id,seq,node_id,kind,payload_json,created_at) VALUES(?,(SELECT COALESCE(MAX(seq),0)+1 FROM workflow_v2_event WHERE run_id=?),?,?,?,?)`, runID, runID, nodeID, kind, string(payload), nowMillis())
	return err
}

func (s *Store) CreateWorkflowV2Run(ctx context.Context, def WorkflowV2Definition, trigger string, nodeIDs []string) (WorkflowV2Run, error) {
	if !def.Enabled || def.ID == "" || len(nodeIDs) == 0 || len(nodeIDs) > 32 || trigger == "" {
		return WorkflowV2Run{}, errors.New("工作流 v2 无法启动")
	}
	id, err := newID()
	if err != nil {
		return WorkflowV2Run{}, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return WorkflowV2Run{}, err
	}
	defer tx.Rollback()
	var currentRevision, enabled int
	if err := tx.QueryRowContext(ctx, `SELECT revision,enabled FROM workflow_v2_definition WHERE id=?`, def.ID).Scan(&currentRevision, &enabled); err != nil {
		return WorkflowV2Run{}, err
	}
	if currentRevision != def.Revision || enabled != 1 {
		return WorkflowV2Run{}, errors.New("工作流 v2 定义已变化或停用")
	}
	now := nowMillis()
	if _, err = tx.ExecContext(ctx, `INSERT INTO workflow_v2_run(id,definition_id,lake_id,name,revision,trigger,spec_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'pending',?,?)`, id, def.ID, def.LakeID, def.Name, def.Revision, trigger, string(def.Spec), now, now); err != nil {
		return WorkflowV2Run{}, err
	}
	seen := make(map[string]bool, len(nodeIDs))
	for _, nodeID := range nodeIDs {
		if err := validName(nodeID); err != nil {
			return WorkflowV2Run{}, err
		}
		if seen[nodeID] {
			return WorkflowV2Run{}, errors.New("工作流 v2 节点 ID 重复")
		}
		seen[nodeID] = true
		if _, err = tx.ExecContext(ctx, `INSERT INTO workflow_v2_node(run_id,node_id,status,updated_at) VALUES(?,?,'pending',?)`, id, nodeID, now); err != nil {
			return WorkflowV2Run{}, err
		}
	}
	if err := appendWorkflowV2Event(ctx, tx, id, "", "created", json.RawMessage(`{"status":"pending"}`)); err != nil {
		return WorkflowV2Run{}, err
	}
	if err := tx.Commit(); err != nil {
		return WorkflowV2Run{}, err
	}
	return s.GetWorkflowV2Run(ctx, id)
}

func scanWorkflowV2Node(row scanner) (WorkflowV2Node, error) {
	var node WorkflowV2Node
	var input, approval, result string
	var updated int64
	err := row.Scan(&node.RunID, &node.NodeID, &node.Status, &input, &approval, &result, &node.ErrorCode, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return node, ErrNotFound
	}
	if err != nil {
		return node, err
	}
	node.Input = json.RawMessage(input)
	node.Approval = json.RawMessage(approval)
	node.Result = json.RawMessage(result)
	node.UpdatedAt = fromMillis(updated)
	return node, nil
}

func (s *Store) GetWorkflowV2Node(ctx context.Context, runID, nodeID string) (WorkflowV2Node, error) {
	return scanWorkflowV2Node(s.db.QueryRowContext(ctx, `SELECT run_id,node_id,status,input_json,approval_json,result_json,error_code,updated_at FROM workflow_v2_node WHERE run_id=? AND node_id=?`, runID, nodeID))
}

func (s *Store) GetWorkflowV2Run(ctx context.Context, id string) (WorkflowV2Run, error) {
	var run WorkflowV2Run
	var definitionID sql.NullString
	var spec string
	var created, updated int64
	err := s.db.QueryRowContext(ctx, `SELECT id,definition_id,lake_id,name,revision,trigger,spec_json,status,created_at,updated_at FROM workflow_v2_run WHERE id=?`, id).Scan(&run.ID, &definitionID, &run.LakeID, &run.Name, &run.Revision, &run.Trigger, &spec, &run.Status, &created, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return run, ErrNotFound
	}
	if err != nil {
		return run, err
	}
	run.DefinitionID = definitionID.String
	run.Spec = json.RawMessage(spec)
	run.CreatedAt = fromMillis(created)
	run.UpdatedAt = fromMillis(updated)
	rows, err := s.db.QueryContext(ctx, `SELECT run_id,node_id,status,input_json,approval_json,result_json,error_code,updated_at FROM workflow_v2_node WHERE run_id=? ORDER BY rowid`, id)
	if err != nil {
		return run, err
	}
	defer rows.Close()
	run.Nodes = make([]WorkflowV2Node, 0)
	for rows.Next() {
		node, err := scanWorkflowV2Node(rows)
		if err != nil {
			return run, err
		}
		run.Nodes = append(run.Nodes, node)
	}
	return run, rows.Err()
}

type WorkflowV2NodeChange struct {
	RunID     string
	NodeID    string
	From      string
	To        string
	Input     json.RawMessage
	Approval  json.RawMessage
	Result    json.RawMessage
	ErrorCode string
}

func validWorkflowV2Transition(from, to string) bool {
	switch from {
	case "pending":
		return to == "waiting_approval" || to == "running" || to == "skipped" || to == "failed" || to == "cancelled"
	case "waiting_approval":
		return to == "running" || to == "failed" || to == "pending" || to == "cancelled"
	case "running":
		return to == "completed" || to == "failed" || to == "unknown" || to == "cancelled"
	case "failed", "unknown", "cancelled", "skipped":
		return to == "pending"
	default:
		return false
	}
}

func validWorkflowV2ErrorCode(value string) bool {
	if len(value) > 64 {
		return false
	}
	for _, char := range value {
		if char != '_' && (char < 'a' || char > 'z') && (char < '0' || char > '9') {
			return false
		}
	}
	return true
}

func (s *Store) TransitionWorkflowV2Node(ctx context.Context, change WorkflowV2NodeChange) (WorkflowV2Node, error) {
	if change.RunID == "" || change.NodeID == "" || !validWorkflowV2Transition(change.From, change.To) || !validWorkflowV2ErrorCode(change.ErrorCode) {
		return WorkflowV2Node{}, errors.New("工作流 v2 节点状态转换无效")
	}
	for _, raw := range []json.RawMessage{change.Input, change.Approval, change.Result} {
		if len(raw) > 64*1024 || len(raw) > 0 && !json.Valid(raw) {
			return WorkflowV2Node{}, errors.New("工作流 v2 节点快照无效")
		}
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return WorkflowV2Node{}, err
	}
	defer tx.Rollback()
	var input, approval, result string
	var current string
	if err := tx.QueryRowContext(ctx, `SELECT status,input_json,approval_json,result_json FROM workflow_v2_node WHERE run_id=? AND node_id=?`, change.RunID, change.NodeID).Scan(&current, &input, &approval, &result); err != nil {
		return WorkflowV2Node{}, err
	}
	if current != change.From {
		return WorkflowV2Node{}, errors.New("工作流 v2 节点状态已变化")
	}
	if change.Input != nil {
		input = string(change.Input)
	}
	if change.Approval != nil {
		approval = string(change.Approval)
	}
	if change.Result != nil {
		result = string(change.Result)
	}
	resultChange, err := tx.ExecContext(ctx, `UPDATE workflow_v2_node SET status=?,input_json=?,approval_json=?,result_json=?,error_code=?,updated_at=? WHERE run_id=? AND node_id=? AND status=?`, change.To, input, approval, result, change.ErrorCode, nowMillis(), change.RunID, change.NodeID, change.From)
	if err != nil {
		return WorkflowV2Node{}, err
	}
	if count, _ := resultChange.RowsAffected(); count != 1 {
		return WorkflowV2Node{}, errors.New("工作流 v2 节点状态已变化")
	}
	payload, _ := json.Marshal(map[string]string{"from": change.From, "to": change.To})
	if err := appendWorkflowV2Event(ctx, tx, change.RunID, change.NodeID, "node_status", payload); err != nil {
		return WorkflowV2Node{}, err
	}
	if err := tx.Commit(); err != nil {
		return WorkflowV2Node{}, err
	}
	return s.GetWorkflowV2Node(ctx, change.RunID, change.NodeID)
}

func (s *Store) SetWorkflowV2RunStatus(ctx context.Context, id, status string) error {
	switch status {
	case "pending", "running", "waiting_approval", "completed", "failed", "interrupted":
	default:
		return errors.New("工作流 v2 运行状态无效")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, `UPDATE workflow_v2_run SET status=?,updated_at=? WHERE id=?`, status, nowMillis(), id)
	if err != nil {
		return err
	}
	if n, _ := result.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	payload, _ := json.Marshal(map[string]string{"status": status})
	if err := appendWorkflowV2Event(ctx, tx, id, "", "run_status", payload); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) ListWorkflowV2Events(ctx context.Context, runID string) ([]WorkflowV2Event, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT run_id,seq,node_id,kind,payload_json,created_at FROM workflow_v2_event WHERE run_id=? ORDER BY seq`, runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	events := make([]WorkflowV2Event, 0)
	for rows.Next() {
		var event WorkflowV2Event
		var payload string
		var created int64
		if err := rows.Scan(&event.RunID, &event.Sequence, &event.NodeID, &event.Kind, &payload, &created); err != nil {
			return nil, err
		}
		event.Payload = json.RawMessage(payload)
		event.CreatedAt = fromMillis(created)
		events = append(events, event)
	}
	return events, rows.Err()
}

func (s *Store) RecentWorkflowV2Runs(ctx context.Context, lakeID string) ([]WorkflowV2Run, error) {
	query := `SELECT id FROM workflow_v2_run`
	var args []any
	if lakeID != "" {
		query += ` WHERE lake_id=?`
		args = append(args, lakeID)
	}
	query += ` ORDER BY created_at DESC,id LIMIT 50`
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	var ids []string
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
	result := make([]WorkflowV2Run, 0, len(ids))
	for _, id := range ids {
		run, err := s.GetWorkflowV2Run(ctx, id)
		if err != nil {
			return nil, err
		}
		result = append(result, run)
	}
	return result, nil
}
func (s *Store) SetWorkflowV2Enabled(ctx context.Context, id string, enabled bool) error {
	result, err := s.db.ExecContext(ctx, `UPDATE workflow_v2_definition SET enabled=?,updated_at=? WHERE id=?`, enabled, nowMillis(), id)
	if err != nil {
		return err
	}
	if n, _ := result.RowsAffected(); n != 1 {
		return ErrNotFound
	}
	return nil
}
func (s *Store) UpdateWorkflowV2Revision(ctx context.Context, id string, revision int, name, description string, spec json.RawMessage) (WorkflowV2Definition, error) {
	if err := validName(name); err != nil {
		return WorkflowV2Definition{}, err
	}
	if len(description) > 2000 || len(spec) == 0 || len(spec) > 256*1024 || !json.Valid(spec) {
		return WorkflowV2Definition{}, errors.New("工作流 v2 定义无效")
	}
	result, err := s.db.ExecContext(ctx, `UPDATE workflow_v2_definition SET name=?,description=?,spec_json=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?`, name, description, string(spec), nowMillis(), id, revision)
	if err != nil {
		return WorkflowV2Definition{}, err
	}
	if n, _ := result.RowsAffected(); n != 1 {
		return WorkflowV2Definition{}, errors.New("工作流已被其他编辑更新，请刷新后重试")
	}
	return s.GetWorkflowV2(ctx, id)
}
