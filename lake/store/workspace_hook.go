package store

import (
	"context"
	"database/sql"
	"encoding/hex"
	"errors"
	"path/filepath"
	"time"
)

type WorkspaceHook struct {
	WorkspacePath string    `json:"workspace_path"`
	Digest        string    `json:"sha256"`
	Enabled       bool      `json:"enabled"`
	UpdatedAt     time.Time `json:"updated_at"`
}

func (s *Store) GetWorkspaceHook(ctx context.Context, workspacePath string) (WorkspaceHook, error) {
	var item WorkspaceHook
	var enabled int
	var updated int64
	err := s.db.QueryRowContext(ctx, `SELECT workspace_path,sha256,enabled,updated_at FROM extension_config WHERE kind='hook' AND name='workspace' AND workspace_path=?`, workspacePath).Scan(&item.WorkspacePath, &item.Digest, &enabled, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return WorkspaceHook{}, ErrNotFound
	}
	if err != nil {
		return WorkspaceHook{}, err
	}
	item.Enabled, item.UpdatedAt = enabled == 1, fromMillis(updated)
	return item, nil
}

func (s *Store) SaveWorkspaceHook(ctx context.Context, workspacePath, digest string) (WorkspaceHook, error) {
	decoded, err := hex.DecodeString(digest)
	if !filepath.IsAbs(workspacePath) || filepath.Clean(workspacePath) != workspacePath || err != nil || len(decoded) != 32 {
		return WorkspaceHook{}, errors.New("Hook 工作区或声明无效")
	}
	now := nowMillis()
	_, err = s.db.ExecContext(ctx, `INSERT INTO extension_config(kind,name,workspace_path,version,source,sha256,install_path,manifest_json,declaration_sha256,enabled,created_at,updated_at)
	VALUES('hook','workspace',?,'1',?,?,?,?,?,0,?,?)
	ON CONFLICT(kind,name,workspace_path) DO UPDATE SET source=excluded.source,sha256=excluded.sha256,install_path=excluded.install_path,manifest_json=excluded.manifest_json,declaration_sha256=excluded.declaration_sha256,enabled=CASE WHEN extension_config.sha256=excluded.sha256 THEN extension_config.enabled ELSE 0 END,updated_at=excluded.updated_at`,
		workspacePath, filepath.Join(workspacePath, ".lake", "hooks.json"), digest, workspacePath, `{}`, digest, now, now)
	if err != nil {
		return WorkspaceHook{}, err
	}
	return s.GetWorkspaceHook(ctx, workspacePath)
}

func (s *Store) SetWorkspaceHookEnabled(ctx context.Context, workspacePath, digest string, enabled bool) (WorkspaceHook, error) {
	value := 0
	if enabled {
		value = 1
	}
	result, err := s.db.ExecContext(ctx, `UPDATE extension_config SET enabled=?,updated_at=? WHERE kind='hook' AND name='workspace' AND workspace_path=? AND sha256=?`, value, nowMillis(), workspacePath, digest)
	if err != nil {
		return WorkspaceHook{}, err
	}
	if count, _ := result.RowsAffected(); count == 0 {
		return WorkspaceHook{}, errors.New("Hook 声明已变化，请重新确认")
	}
	return s.GetWorkspaceHook(ctx, workspacePath)
}
