package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"path"
	"strings"
	"time"
)

type CodeWorkspace struct {
	ID         string    `json:"id"`
	LakeID     string    `json:"lake_id"`
	Lake       string    `json:"lake"`
	ResourceID string    `json:"resource_id"`
	Name       string    `json:"name"`
	RemoteRoot string    `json:"remote_root"`
	Authorized bool      `json:"authorized"`
	Host       string    `json:"host"`
	Port       int       `json:"port"`
	Username   string    `json:"username"`
	CreatedAt  time.Time `json:"created_at"`
	UpdatedAt  time.Time `json:"updated_at"`
}

func ValidRemoteRoot(root string) bool {
	if !strings.HasPrefix(root, "/") || root == "/" || len(root) > 1024 || strings.ContainsAny(root, "\x00\r\n\t\\") || path.Clean(root) != root {
		return false
	}
	for _, part := range strings.Split(root, "/") {
		if part == ".." || part == "." {
			return false
		}
	}
	return true
}

const codeWorkspaceSelect = `SELECT w.id,w.lake_id,l.name,w.resource_id,w.name,w.remote_root,w.authorized,w.created_at,w.updated_at,r.spec FROM code_workspace w JOIN lake l ON l.id=w.lake_id JOIN resource r ON r.id=w.resource_id`

func scanCodeWorkspace(row scanner) (CodeWorkspace, error) {
	var item CodeWorkspace
	var authorized int
	var created, updated int64
	var spec string
	if err := row.Scan(&item.ID, &item.LakeID, &item.Lake, &item.ResourceID, &item.Name, &item.RemoteRoot, &authorized, &created, &updated, &spec); errors.Is(err, sql.ErrNoRows) {
		return CodeWorkspace{}, ErrNotFound
	} else if err != nil {
		return CodeWorkspace{}, err
	}
	item.Authorized = authorized != 0
	item.CreatedAt, item.UpdatedAt = fromMillis(created), fromMillis(updated)
	var decoded struct {
		SSH SSHSpec `json:"ssh"`
	}
	if err := json.Unmarshal([]byte(spec), &decoded); err != nil {
		return CodeWorkspace{}, err
	}
	item.Host, item.Port, item.Username = decoded.SSH.Host, decoded.SSH.Port, decoded.SSH.Username
	return item, nil
}

func (s *Store) CreateCodeWorkspace(ctx context.Context, lakeID, resourceID, name, remoteRoot string) (CodeWorkspace, error) {
	if err := validName(name); err != nil {
		return CodeWorkspace{}, err
	}
	if !ValidRemoteRoot(remoteRoot) {
		return CodeWorkspace{}, errors.New("远程项目根目录必须是规范绝对路径，且不能为 / ")
	}
	resource, err := s.GetResource(ctx, resourceID)
	if err != nil {
		return CodeWorkspace{}, err
	}
	if resource.LakeID != lakeID || resource.Kind != "host" {
		return CodeWorkspace{}, errors.New("远程代码工作区必须绑定同一湖中的 SSH 主机")
	}
	id, err := newID()
	if err != nil {
		return CodeWorkspace{}, err
	}
	now := nowMillis()
	if _, err := s.db.ExecContext(ctx, `INSERT INTO code_workspace(id,lake_id,resource_id,name,remote_root,authorized,created_at,updated_at) VALUES(?,?,?,?,?,0,?,?)`, id, lakeID, resourceID, name, remoteRoot, now, now); err != nil {
		return CodeWorkspace{}, err
	}
	return s.GetCodeWorkspace(ctx, id)
}

func (s *Store) GetCodeWorkspace(ctx context.Context, id string) (CodeWorkspace, error) {
	return scanCodeWorkspace(s.db.QueryRowContext(ctx, codeWorkspaceSelect+` WHERE w.id=?`, id))
}

func (s *Store) ListCodeWorkspaces(ctx context.Context, lakeID string) ([]CodeWorkspace, error) {
	query := codeWorkspaceSelect
	var args []any
	if lakeID != "" {
		query += ` WHERE w.lake_id=?`
		args = append(args, lakeID)
	}
	query += ` ORDER BY l.name,w.name`
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]CodeWorkspace, 0)
	for rows.Next() {
		item, err := scanCodeWorkspace(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func (s *Store) SetCodeWorkspaceAuthorized(ctx context.Context, id string, authorized bool) (CodeWorkspace, error) {
	value := 0
	if authorized {
		value = 1
	}
	result, err := s.db.ExecContext(ctx, `UPDATE code_workspace SET authorized=?,updated_at=? WHERE id=?`, value, nowMillis(), id)
	if err != nil {
		return CodeWorkspace{}, err
	}
	if n, _ := result.RowsAffected(); n == 0 {
		return CodeWorkspace{}, ErrNotFound
	}
	return s.GetCodeWorkspace(ctx, id)
}

func (s *Store) SetConversationCodeWorkspace(ctx context.Context, conversationID, workspaceID string) (Conversation, error) {
	var result sql.Result
	var err error
	if workspaceID == "" {
		result, err = s.db.ExecContext(ctx, `UPDATE conversation SET remote_workspace_id=NULL,updated_at=? WHERE id=? AND archived_at IS NULL`, nowMillis(), conversationID)
	} else {
		result, err = s.db.ExecContext(ctx, `UPDATE conversation SET remote_workspace_id=?,project_id=NULL,updated_at=? WHERE id=? AND archived_at IS NULL AND lake_id=(SELECT lake_id FROM code_workspace WHERE id=? AND authorized=1)`, workspaceID, nowMillis(), conversationID, workspaceID)
	}
	if err != nil {
		return Conversation{}, err
	}
	if n, _ := result.RowsAffected(); n == 0 {
		return Conversation{}, ErrNotFound
	}
	return s.GetConversation(ctx, conversationID)
}
