/*
 * Copyright 2026 CloudWeGo Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"
)

const maxScriptBytes = 1 << 20

type ScriptInput struct {
	Name        string
	Language    string
	Description string
	LakeID      string
	ResourceID  string
	Content     []byte
}

type Script struct {
	ID          string
	Name        string
	Language    string
	Path        string // Relative to Store.Root().
	SHA256      string
	Description string
	LakeID      string
	ResourceID  string
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

// SaveScript writes an immutable file and indexes it in SQLite. Exactly one
// of LakeID and ResourceID must be supplied.
func (s *Store) SaveScript(ctx context.Context, in ScriptInput) (Script, error) {
	if err := validName(in.Name); err != nil {
		return Script{}, err
	}
	if in.Language == "" || len(in.Language) > 64 {
		return Script{}, errors.New("invalid script language")
	}
	if (in.LakeID == "") == (in.ResourceID == "") {
		return Script{}, errors.New("script must belong to exactly one lake or resource")
	}
	if len(in.Content) == 0 || len(in.Content) > maxScriptBytes {
		return Script{}, fmt.Errorf("script size must be 1 to %d bytes", maxScriptBytes)
	}
	id, err := newID()
	if err != nil {
		return Script{}, err
	}
	relativePath := filepath.Join("scripts", id)
	path := filepath.Join(s.root, relativePath)
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return Script{}, err
	}
	cleanup := true
	defer func() {
		if cleanup {
			os.Remove(path)
		}
	}()
	if _, err := file.Write(in.Content); err != nil {
		file.Close()
		return Script{}, err
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return Script{}, err
	}
	if err := file.Close(); err != nil {
		return Script{}, err
	}
	hash := sha256.Sum256(in.Content)
	now := nowMillis()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Script{}, err
	}
	defer tx.Rollback()
	_, err = tx.ExecContext(ctx, `INSERT INTO script(id, name, language, path, sha256, description, lake_id, resource_id, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, in.Name, in.Language, relativePath, hex.EncodeToString(hash[:]), in.Description, nullString(in.LakeID), nullString(in.ResourceID), now, now)
	if err != nil {
		return Script{}, fmt.Errorf("index script: %w", err)
	}
	if in.ResourceID != "" {
		attachID, err := newID()
		if err != nil {
			return Script{}, err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO attach(id, resource_id, kind, ref, meta, created_at) VALUES (?, ?, 'script', ?, '{}', ?)`, attachID, in.ResourceID, id, now); err != nil {
			return Script{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return Script{}, err
	}
	cleanup = false
	return Script{ID: id, Name: in.Name, Language: in.Language, Path: relativePath, SHA256: hex.EncodeToString(hash[:]), Description: in.Description, LakeID: in.LakeID, ResourceID: in.ResourceID, CreatedAt: fromMillis(now), UpdatedAt: fromMillis(now)}, nil
}

func (s *Store) GetScript(ctx context.Context, id string) (Script, error) {
	return scanScript(s.db.QueryRowContext(ctx, scriptSelect+` WHERE id = ?`, id))
}

func (s *Store) ListScripts(ctx context.Context, lakeID, resourceID string) ([]Script, error) {
	if (lakeID == "") == (resourceID == "") {
		return nil, errors.New("select exactly one lake or resource")
	}
	field, id := "lake_id", lakeID
	if resourceID != "" {
		field, id = "resource_id", resourceID
	}
	rows, err := s.db.QueryContext(ctx, scriptSelect+` WHERE `+field+` = ? ORDER BY name`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Script
	for rows.Next() {
		script, err := scanScript(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, script)
	}
	return out, rows.Err()
}

// ReadScript detects edits to the file after it was indexed. The caller must
// reject a mismatch before sending a script to a remote host.
func (s *Store) ReadScript(ctx context.Context, id string) (Script, []byte, error) {
	script, err := s.GetScript(ctx, id)
	if err != nil {
		return Script{}, nil, err
	}
	if script.Path != filepath.Join("scripts", script.ID) {
		return Script{}, nil, errors.New("invalid indexed script path")
	}
	path := filepath.Join(s.root, script.Path)
	info, err := os.Lstat(path)
	if err != nil {
		return Script{}, nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > maxScriptBytes {
		return Script{}, nil, errors.New("script file is not a regular file within size limit")
	}
	file, err := os.Open(path)
	if err != nil {
		return Script{}, nil, err
	}
	defer file.Close()
	content, err := io.ReadAll(io.LimitReader(file, maxScriptBytes+1))
	if err != nil {
		return Script{}, nil, err
	}
	if len(content) > maxScriptBytes {
		return Script{}, nil, errors.New("script file exceeds size limit")
	}
	hash := sha256.Sum256(content)
	if script.SHA256 != hex.EncodeToString(hash[:]) {
		return Script{}, nil, errors.New("script content differs from indexed sha256")
	}
	return script, content, nil
}

const scriptSelect = `SELECT id, name, language, path, sha256, description, lake_id, resource_id, created_at, updated_at FROM script`

func scanScript(row scanner) (Script, error) {
	var script Script
	var lakeID, resourceID sql.NullString
	var created, updated int64
	err := row.Scan(&script.ID, &script.Name, &script.Language, &script.Path, &script.SHA256, &script.Description, &lakeID, &resourceID, &created, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return Script{}, ErrNotFound
	}
	if err != nil {
		return Script{}, err
	}
	script.LakeID, script.ResourceID = lakeID.String, resourceID.String
	script.CreatedAt, script.UpdatedAt = fromMillis(created), fromMillis(updated)
	return script, nil
}

func nullString(value string) any {
	if value == "" {
		return nil
	}
	return value
}
