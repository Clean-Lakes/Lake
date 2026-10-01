package store

import (
	"context"
	"database/sql"
	"errors"
	"regexp"
	"strings"
	"time"
)

type MemoryFactInput struct {
	LakeID               string
	ProjectID            string
	SourceConversationID string
	SourceEventSeq       uint64
	Text                 string
}

type MemoryFact struct {
	ID                   string     `json:"id"`
	LakeID               string     `json:"lake_id"`
	ProjectID            string     `json:"project_id,omitempty"`
	SourceConversationID string     `json:"source_conversation_id"`
	SourceEventSeq       uint64     `json:"source_event_seq"`
	Text                 string     `json:"text"`
	CreatedAt            time.Time  `json:"created_at"`
	UpdatedAt            time.Time  `json:"updated_at"`
	DeletedAt            *time.Time `json:"deleted_at,omitempty"`
}

var secretFactPattern = regexp.MustCompile(`(?i)(private key|api[_ -]?key|password|passwd|access[_ -]?token|secret|密码|私钥|密钥|访问令牌|口令)`)

func validMemoryText(value string) bool {
	return value != "" && value == strings.TrimSpace(value) && len(value) <= 1024 && !sensitiveEventText(value) && !secretFactPattern.MatchString(value)
}

func (s *Store) MemoryEnabled(ctx context.Context, lakeID string) (bool, error) {
	if _, err := s.GetLake(ctx, lakeID); err != nil {
		return false, err
	}
	var enabled bool
	err := s.db.QueryRowContext(ctx, `SELECT enabled FROM memory_policy WHERE lake_id=?`, lakeID).Scan(&enabled)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return enabled, err
}

func (s *Store) SetMemoryEnabled(ctx context.Context, lakeID string, enabled bool) error {
	if _, err := s.GetLake(ctx, lakeID); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO memory_policy(lake_id,enabled,updated_at) VALUES(?,?,?)
		ON CONFLICT(lake_id) DO UPDATE SET enabled=excluded.enabled,updated_at=excluded.updated_at`, lakeID, enabled, nowMillis())
	return err
}

func (s *Store) AddMemoryFact(ctx context.Context, input MemoryFactInput) (MemoryFact, error) {
	if input.LakeID == "" || input.SourceConversationID == "" || input.SourceEventSeq == 0 || !validMemoryText(input.Text) {
		return MemoryFact{}, errors.New("invalid memory fact")
	}
	ID, err := newID()
	if err != nil {
		return MemoryFact{}, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return MemoryFact{}, err
	}
	defer tx.Rollback()
	var enabled bool
	err = tx.QueryRowContext(ctx, `SELECT enabled FROM memory_policy WHERE lake_id=?`, input.LakeID).Scan(&enabled)
	if errors.Is(err, sql.ErrNoRows) || !enabled && err == nil {
		return MemoryFact{}, errors.New("跨会话记忆未启用")
	}
	if err != nil {
		return MemoryFact{}, err
	}
	var sourceLake, sourceKind string
	if err := tx.QueryRowContext(ctx, `SELECT c.lake_id,e.kind FROM conversation_event e JOIN conversation c ON c.id=e.conversation_id WHERE e.conversation_id=? AND e.seq=?`, input.SourceConversationID, input.SourceEventSeq).Scan(&sourceLake, &sourceKind); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return MemoryFact{}, ErrNotFound
		}
		return MemoryFact{}, err
	}
	if sourceLake != input.LakeID || sourceKind != "user" {
		return MemoryFact{}, errors.New("记忆来源必须是同一湖的用户事件")
	}
	var project any
	if input.ProjectID != "" {
		var projectLake string
		if err := tx.QueryRowContext(ctx, `SELECT lake_id FROM code_project WHERE id=?`, input.ProjectID).Scan(&projectLake); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return MemoryFact{}, ErrNotFound
			}
			return MemoryFact{}, err
		}
		if projectLake != input.LakeID {
			return MemoryFact{}, errors.New("代码项目不属于该湖")
		}
		project = input.ProjectID
	}
	now := nowMillis()
	if _, err := tx.ExecContext(ctx, `INSERT INTO memory_fact(id,lake_id,project_id,source_conversation_id,source_event_seq,text,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`, ID, input.LakeID, project, input.SourceConversationID, input.SourceEventSeq, input.Text, now, now); err != nil {
		return MemoryFact{}, err
	}
	if err := tx.Commit(); err != nil {
		return MemoryFact{}, err
	}
	return MemoryFact{ID: ID, LakeID: input.LakeID, ProjectID: input.ProjectID, SourceConversationID: input.SourceConversationID, SourceEventSeq: input.SourceEventSeq, Text: input.Text, CreatedAt: fromMillis(now), UpdatedAt: fromMillis(now)}, nil
}

func (s *Store) ListMemoryFacts(ctx context.Context, lakeID, projectID string) ([]MemoryFact, error) {
	if _, err := s.GetLake(ctx, lakeID); err != nil {
		return nil, err
	}
	if projectID != "" {
		project, err := s.GetCodeProject(ctx, projectID)
		if err != nil {
			return nil, err
		}
		if project.LakeID != lakeID {
			return nil, errors.New("代码项目不属于该湖")
		}
	}
	rows, err := s.db.QueryContext(ctx, `SELECT id,lake_id,COALESCE(project_id,''),source_conversation_id,source_event_seq,text,created_at,updated_at,deleted_at
		FROM memory_fact WHERE lake_id=? AND deleted_at IS NULL AND (project_id IS NULL OR project_id=?) ORDER BY created_at,id`, lakeID, projectID)
	if err != nil {
		return nil, err
	}
	return scanMemoryFacts(rows)
}

func (s *Store) ListAllMemoryFacts(ctx context.Context, lakeID string) ([]MemoryFact, error) {
	if _, err := s.GetLake(ctx, lakeID); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT id,lake_id,COALESCE(project_id,''),source_conversation_id,source_event_seq,text,created_at,updated_at,deleted_at
		FROM memory_fact WHERE lake_id=? AND deleted_at IS NULL ORDER BY created_at,id`, lakeID)
	if err != nil {
		return nil, err
	}
	return scanMemoryFacts(rows)
}

func scanMemoryFacts(rows *sql.Rows) ([]MemoryFact, error) {
	defer rows.Close()
	var facts []MemoryFact
	for rows.Next() {
		var fact MemoryFact
		var sourceSeq uint64
		var created, updated int64
		var deleted sql.NullInt64
		if err := rows.Scan(&fact.ID, &fact.LakeID, &fact.ProjectID, &fact.SourceConversationID, &sourceSeq, &fact.Text, &created, &updated, &deleted); err != nil {
			return nil, err
		}
		fact.SourceEventSeq, fact.CreatedAt, fact.UpdatedAt = sourceSeq, fromMillis(created), fromMillis(updated)
		if deleted.Valid {
			at := fromMillis(deleted.Int64)
			fact.DeletedAt = &at
		}
		facts = append(facts, fact)
	}
	return facts, rows.Err()
}

func (s *Store) ActiveMemoryFacts(ctx context.Context, lakeID, projectID string) ([]MemoryFact, error) {
	enabled, err := s.MemoryEnabled(ctx, lakeID)
	if err != nil || !enabled {
		return nil, err
	}
	facts, err := s.ListMemoryFacts(ctx, lakeID, projectID)
	if err != nil {
		return nil, err
	}
	if len(facts) > 16 {
		facts = facts[len(facts)-16:]
	}
	return facts, nil
}

func (s *Store) EditMemoryFact(ctx context.Context, lakeID, id, text string) error {
	if !validMemoryText(text) {
		return errors.New("invalid memory fact")
	}
	result, err := s.db.ExecContext(ctx, `UPDATE memory_fact SET text=?,updated_at=? WHERE id=? AND lake_id=? AND deleted_at IS NULL`, text, nowMillis(), id, lakeID)
	if err != nil {
		return err
	}
	if count, _ := result.RowsAffected(); count == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) DeleteMemoryFact(ctx context.Context, lakeID, id string) error {
	result, err := s.db.ExecContext(ctx, `UPDATE memory_fact SET deleted_at=?,updated_at=? WHERE id=? AND lake_id=? AND deleted_at IS NULL`, nowMillis(), nowMillis(), id, lakeID)
	if err != nil {
		return err
	}
	if count, _ := result.RowsAffected(); count == 0 {
		return ErrNotFound
	}
	return nil
}
