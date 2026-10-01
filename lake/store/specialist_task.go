package store

import (
	"context"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"
)

type SpecialistTaskInput struct {
	ID             string `json:"id"`
	ConversationID string `json:"conversation_id,omitempty"`
	ParentRunID    string `json:"parent_run_id"`
	ParentTaskID   string `json:"parent_task_id,omitempty"`
	Name           string `json:"name"`
	Model          string `json:"model"`
	ScopeJSON      string `json:"scope_json"`
	RequestSHA256  string `json:"request_sha256"`
}

// SpecialistTask stores lifecycle and digests, never raw task arguments or model output.
type SpecialistTask struct {
	SpecialistTaskInput
	ResponseSHA256 string    `json:"response_sha256,omitempty"`
	Status         string    `json:"status"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt      time.Time `json:"updated_at"`
}

func validSpecialistDigest(value string) bool {
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == 32
}

func optionalID(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func (s *Store) CreateSpecialistTask(ctx context.Context, input SpecialistTaskInput) (SpecialistTask, error) {
	if input.ID == "" || input.ParentRunID == "" || input.Name == "" || input.Model == "" || len(input.ScopeJSON) > 16*1024 || !json.Valid([]byte(input.ScopeJSON)) || !validSpecialistDigest(input.RequestSHA256) {
		return SpecialistTask{}, errors.New("专员任务元数据无效")
	}
	now := nowMillis()
	_, err := s.db.ExecContext(ctx, `INSERT INTO specialist_task(id,conversation_id,parent_run_id,parent_task_id,name,model,scope_json,request_sha256,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`, input.ID, optionalID(input.ConversationID), input.ParentRunID, optionalID(input.ParentTaskID), input.Name, input.Model, input.ScopeJSON, input.RequestSHA256, "delegated", now, now)
	if err != nil {
		return SpecialistTask{}, err
	}
	return s.GetSpecialistTask(ctx, input.ID)
}

const specialistTaskSelect = `SELECT id,conversation_id,parent_run_id,parent_task_id,name,model,scope_json,request_sha256,response_sha256,status,created_at,updated_at FROM specialist_task`

func scanSpecialistTask(row scanner) (SpecialistTask, error) {
	var task SpecialistTask
	var conversationID, parentTaskID sql.NullString
	var created, updated int64
	err := row.Scan(&task.ID, &conversationID, &task.ParentRunID, &parentTaskID, &task.Name, &task.Model, &task.ScopeJSON, &task.RequestSHA256, &task.ResponseSHA256, &task.Status, &created, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return SpecialistTask{}, ErrNotFound
	}
	if err != nil {
		return SpecialistTask{}, err
	}
	task.ConversationID, task.ParentTaskID = conversationID.String, parentTaskID.String
	task.CreatedAt, task.UpdatedAt = fromMillis(created), fromMillis(updated)
	return task, nil
}

func (s *Store) GetSpecialistTask(ctx context.Context, id string) (SpecialistTask, error) {
	return scanSpecialistTask(s.db.QueryRowContext(ctx, specialistTaskSelect+` WHERE id=?`, id))
}

func (s *Store) ListSpecialistTasks(ctx context.Context, parentRunID string) ([]SpecialistTask, error) {
	if parentRunID == "" {
		return nil, errors.New("专员父运行 ID 不能为空")
	}
	rows, err := s.db.QueryContext(ctx, specialistTaskSelect+` WHERE parent_run_id=? ORDER BY created_at,id`, parentRunID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	tasks := make([]SpecialistTask, 0)
	for rows.Next() {
		task, err := scanSpecialistTask(rows)
		if err != nil {
			return nil, err
		}
		tasks = append(tasks, task)
	}
	return tasks, rows.Err()
}

func (s *Store) UpdateSpecialistTask(ctx context.Context, id, status, responseSHA string) (SpecialistTask, error) {
	from := ""
	switch status {
	case "running":
		from = "delegated"
	case "completed", "failed", "unknown":
		from = "running"
	default:
		return SpecialistTask{}, errors.New("专员任务状态无效")
	}
	if responseSHA != "" && !validSpecialistDigest(responseSHA) {
		return SpecialistTask{}, errors.New("专员结果摘要无效")
	}
	if status == "completed" && responseSHA == "" {
		return SpecialistTask{}, errors.New("完成的专员任务缺少结果摘要")
	}
	result, err := s.db.ExecContext(ctx, `UPDATE specialist_task SET status=?,response_sha256=?,updated_at=? WHERE id=? AND status=?`, status, responseSHA, nowMillis(), id, from)
	if err != nil {
		return SpecialistTask{}, err
	}
	if count, _ := result.RowsAffected(); count == 0 {
		return SpecialistTask{}, errors.New("专员任务状态已变化")
	}
	return s.GetSpecialistTask(ctx, id)
}

// Interrupted tasks may have executed side effects. Reopening a conversation
// records uncertainty rather than replaying their requests.
func (s *Store) MarkInterruptedSpecialistTasks(ctx context.Context, parentRunID string) error {
	if parentRunID == "" {
		return nil
	}
	_, err := s.db.ExecContext(ctx, `UPDATE specialist_task SET status='unknown',updated_at=? WHERE parent_run_id=? AND status IN ('delegated','running')`, nowMillis(), parentRunID)
	return err
}

// ResumeSpecialistTask is called only while holding the private task file lock.
func (s *Store) ResumeSpecialistTask(ctx context.Context, id string) (SpecialistTask, error) {
	result, err := s.db.ExecContext(ctx, `UPDATE specialist_task SET status='running',response_sha256='',updated_at=? WHERE id=? AND status IN ('delegated','running','failed','unknown')`, nowMillis(), id)
	if err != nil {
		return SpecialistTask{}, err
	}
	if n, _ := result.RowsAffected(); n != 1 {
		return SpecialistTask{}, errors.New("专员任务已完成或不存在")
	}
	return s.GetSpecialistTask(ctx, id)
}
func (s *Store) RecentSpecialistTasks(ctx context.Context) ([]SpecialistTask, error) {
	rows, err := s.db.QueryContext(ctx, specialistTaskSelect+` ORDER BY updated_at DESC,id LIMIT 100`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	tasks := make([]SpecialistTask, 0)
	for rows.Next() {
		task, err := scanSpecialistTask(rows)
		if err != nil {
			return nil, err
		}
		tasks = append(tasks, task)
	}
	return tasks, rows.Err()
}
