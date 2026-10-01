package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type CodeProject struct {
	ID        string    `json:"id"`
	LakeID    string    `json:"lake_id"`
	Lake      string    `json:"lake"`
	Name      string    `json:"name"`
	Path      string    `json:"path"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

func (s *Store) CreateCodeProject(ctx context.Context, lakeName, name, path string) (CodeProject, error) {
	if err := validName(name); err != nil {
		return CodeProject{}, err
	}
	if strings.TrimSpace(path) == "" {
		return CodeProject{}, errors.New("代码项目路径不能为空")
	}
	lake, err := s.GetLakeByName(ctx, lakeName)
	if err != nil {
		return CodeProject{}, err
	}
	path, err = filepath.Abs(path)
	if err != nil {
		return CodeProject{}, err
	}
	path, err = filepath.EvalSymlinks(path)
	if err != nil {
		return CodeProject{}, fmt.Errorf("打开项目目录: %w", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		return CodeProject{}, err
	}
	if !info.IsDir() {
		return CodeProject{}, errors.New("代码项目路径必须是目录")
	}
	id, err := newID()
	if err != nil {
		return CodeProject{}, err
	}
	now := nowMillis()
	if _, err := s.db.ExecContext(ctx, `INSERT INTO code_project(id,lake_id,name,path,created_at,updated_at) VALUES(?,?,?,?,?,?)`, id, lake.ID, name, path, now, now); err != nil {
		return CodeProject{}, err
	}
	return CodeProject{ID: id, LakeID: lake.ID, Lake: lake.Name, Name: name, Path: path, CreatedAt: fromMillis(now), UpdatedAt: fromMillis(now)}, nil
}

const codeProjectSelect = `SELECT p.id,p.lake_id,l.name,p.name,p.path,p.created_at,p.updated_at FROM code_project p JOIN lake l ON l.id=p.lake_id`

func scanCodeProject(row scanner) (CodeProject, error) {
	var p CodeProject
	var created, updated int64
	err := row.Scan(&p.ID, &p.LakeID, &p.Lake, &p.Name, &p.Path, &created, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return CodeProject{}, ErrNotFound
	}
	if err != nil {
		return CodeProject{}, err
	}
	p.CreatedAt, p.UpdatedAt = fromMillis(created), fromMillis(updated)
	return p, nil
}

func (s *Store) GetCodeProject(ctx context.Context, id string) (CodeProject, error) {
	return scanCodeProject(s.db.QueryRowContext(ctx, codeProjectSelect+` WHERE p.id=?`, id))
}

func (s *Store) ListCodeProjects(ctx context.Context) ([]CodeProject, error) {
	rows, err := s.db.QueryContext(ctx, codeProjectSelect+` ORDER BY l.name,p.name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]CodeProject, 0)
	for rows.Next() {
		p, err := scanCodeProject(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (s *Store) SetConversationProject(ctx context.Context, conversationID, projectID string) (Conversation, error) {
	var result sql.Result
	var err error
	if projectID == "" {
		result, err = s.db.ExecContext(ctx, `UPDATE conversation SET project_id=NULL,updated_at=? WHERE id=? AND archived_at IS NULL`, nowMillis(), conversationID)
	} else {
		result, err = s.db.ExecContext(ctx, `UPDATE conversation SET project_id=?,remote_workspace_id=NULL,updated_at=? WHERE id=? AND archived_at IS NULL AND lake_id=(SELECT lake_id FROM code_project WHERE id=?)`, projectID, nowMillis(), conversationID, projectID)
	}
	if err != nil {
		return Conversation{}, err
	}
	if n, _ := result.RowsAffected(); n == 0 {
		return Conversation{}, ErrNotFound
	}
	return s.GetConversation(ctx, conversationID)
}
