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
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

type Attachment struct {
	ID         string
	ResourceID string
	Kind       string
	Ref        string
	Meta       map[string]string
	CreatedAt  time.Time
}

// SetCredentialRef stores only an opaque location, never private-key material.
// Each resource has one active credential reference.
func (s *Store) SetCredentialRef(ctx context.Context, resourceID, ref string) (Attachment, error) {
	return setCredentialRef(ctx, s.db, resourceID, ref)
}

func setCredentialRef(ctx context.Context, db sqlWriter, resourceID, ref string) (Attachment, error) {
	if !validCredentialRef(ref) {
		return Attachment{}, errors.New("credential ref must use a supported file, keychain, or encrypted-file scheme")
	}
	id, err := newID()
	if err != nil {
		return Attachment{}, err
	}
	_, err = db.ExecContext(ctx, `INSERT INTO attach(id, resource_id, kind, ref, meta, created_at)
		VALUES (?, ?, 'credential', ?, '{}', ?)
		ON CONFLICT(resource_id) WHERE kind = 'credential' DO UPDATE SET ref = excluded.ref`, id, resourceID, ref, nowMillis())
	if err != nil {
		return Attachment{}, fmt.Errorf("set credential ref: %w", err)
	}
	return scanAttachment(db.QueryRowContext(ctx, attachmentSelect+` WHERE resource_id = ? AND kind = 'credential'`, resourceID))
}

func validCredentialRef(ref string) bool {
	for _, prefix := range []string{"file:ssh/", "file:kubeconfig/", "file:database/", "keychain:", "encrypted-file:"} {
		if strings.HasPrefix(ref, prefix) && len(ref) > len(prefix) && !strings.ContainsAny(ref, "\x00\n\r") {
			return true
		}
	}
	return false
}

func (s *Store) AddNote(ctx context.Context, resourceID, text string, meta map[string]string) (Attachment, error) {
	if strings.TrimSpace(text) == "" {
		return Attachment{}, errors.New("note is empty")
	}
	if meta == nil {
		meta = map[string]string{}
	}
	metaJSON, err := json.Marshal(meta)
	if err != nil {
		return Attachment{}, err
	}
	id, err := newID()
	if err != nil {
		return Attachment{}, err
	}
	now := nowMillis()
	_, err = s.db.ExecContext(ctx, `INSERT INTO attach(id, resource_id, kind, ref, meta, created_at) VALUES (?, ?, 'note', ?, ?, ?)`, id, resourceID, text, string(metaJSON), now)
	if err != nil {
		return Attachment{}, err
	}
	return Attachment{ID: id, ResourceID: resourceID, Kind: "note", Ref: text, Meta: meta, CreatedAt: fromMillis(now)}, nil
}

func (s *Store) ListAttachments(ctx context.Context, resourceID string) ([]Attachment, error) {
	rows, err := s.db.QueryContext(ctx, attachmentSelect+` WHERE resource_id = ? ORDER BY created_at, id`, resourceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Attachment
	for rows.Next() {
		attachment, err := scanAttachment(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, attachment)
	}
	return out, rows.Err()
}

const attachmentSelect = `SELECT id, resource_id, kind, ref, meta, created_at FROM attach`

func scanAttachment(row scanner) (Attachment, error) {
	var attachment Attachment
	var metaJSON string
	var created int64
	err := row.Scan(&attachment.ID, &attachment.ResourceID, &attachment.Kind, &attachment.Ref, &metaJSON, &created)
	if errors.Is(err, sql.ErrNoRows) {
		return Attachment{}, ErrNotFound
	}
	if err != nil {
		return Attachment{}, err
	}
	if err := json.Unmarshal([]byte(metaJSON), &attachment.Meta); err != nil {
		return Attachment{}, err
	}
	attachment.CreatedAt = fromMillis(created)
	return attachment, nil
}
