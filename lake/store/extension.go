package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"
)

type PluginExtensionInput struct {
	Name         string
	Version      string
	Source       string
	SHA256       string
	InstallPath  string
	ManifestJSON json.RawMessage
}

type PluginExtension struct {
	PluginExtensionInput
	Enabled   bool      `json:"enabled"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

const pluginSelect = `SELECT name,version,source,sha256,install_path,manifest_json,enabled,created_at,updated_at FROM extension_config WHERE kind='plugin'`

func scanPlugin(row scanner) (PluginExtension, error) {
	var item PluginExtension
	var manifest string
	var enabled int
	var created, updated int64
	err := row.Scan(&item.Name, &item.Version, &item.Source, &item.SHA256, &item.InstallPath, &manifest, &enabled, &created, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return PluginExtension{}, ErrNotFound
	}
	if err != nil {
		return PluginExtension{}, err
	}
	item.ManifestJSON, item.Enabled = json.RawMessage(manifest), enabled == 1
	item.CreatedAt, item.UpdatedAt = fromMillis(created), fromMillis(updated)
	return item, nil
}

func (s *Store) SavePluginExtension(ctx context.Context, input PluginExtensionInput) (PluginExtension, error) {
	if err := validName(input.Name); err != nil {
		return PluginExtension{}, err
	}
	if input.Version == "" || input.Source == "" || input.SHA256 == "" || input.InstallPath == "" || len(input.ManifestJSON) > 64*1024 || !json.Valid(input.ManifestJSON) {
		return PluginExtension{}, errors.New("插件配置无效")
	}
	now := nowMillis()
	_, err := s.db.ExecContext(ctx, `INSERT INTO extension_config(kind,name,version,source,sha256,install_path,manifest_json,enabled,created_at,updated_at)
	VALUES('plugin',?,?,?,?,?,?,0,?,?)
	ON CONFLICT(kind,name,workspace_path) DO UPDATE SET version=excluded.version,source=excluded.source,sha256=excluded.sha256,install_path=excluded.install_path,manifest_json=excluded.manifest_json,enabled=0,updated_at=excluded.updated_at`,
		input.Name, input.Version, input.Source, input.SHA256, input.InstallPath, string(input.ManifestJSON), now, now)
	if err != nil {
		return PluginExtension{}, err
	}
	return s.GetPluginExtension(ctx, input.Name)
}

func (s *Store) GetPluginExtension(ctx context.Context, name string) (PluginExtension, error) {
	return scanPlugin(s.db.QueryRowContext(ctx, pluginSelect+` AND name=? AND workspace_path=''`, name))
}

func (s *Store) ListPluginExtensions(ctx context.Context) ([]PluginExtension, error) {
	rows, err := s.db.QueryContext(ctx, pluginSelect+` AND workspace_path='' ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]PluginExtension, 0)
	for rows.Next() {
		item, err := scanPlugin(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) SetPluginExtensionEnabled(ctx context.Context, name string, enabled bool) (PluginExtension, error) {
	value := 0
	if enabled {
		value = 1
	}
	result, err := s.db.ExecContext(ctx, `UPDATE extension_config SET enabled=?,updated_at=? WHERE kind='plugin' AND name=? AND workspace_path=''`, value, nowMillis(), name)
	if err != nil {
		return PluginExtension{}, err
	}
	if count, _ := result.RowsAffected(); count == 0 {
		return PluginExtension{}, ErrNotFound
	}
	return s.GetPluginExtension(ctx, name)
}
