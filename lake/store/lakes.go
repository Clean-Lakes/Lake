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
	"errors"
	"fmt"
	"time"
)

type Lake struct {
	ID          string
	Name        string
	Description string
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

type LakeResourceCount struct {
	Name          string
	Description   string
	ResourceCount int
}

func (s *Store) CreateLake(ctx context.Context, name, description string) (Lake, error) {
	return createLake(ctx, s.db, name, description)
}

func createLake(ctx context.Context, db sqlWriter, name, description string) (Lake, error) {
	if err := validName(name); err != nil {
		return Lake{}, err
	}
	id, err := newID()
	if err != nil {
		return Lake{}, err
	}
	now := nowMillis()
	_, err = db.ExecContext(ctx, `INSERT INTO lake(id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`, id, name, description, now, now)
	if err != nil {
		return Lake{}, fmt.Errorf("create lake %q: %w", name, err)
	}
	return Lake{ID: id, Name: name, Description: description, CreatedAt: fromMillis(now), UpdatedAt: fromMillis(now)}, nil
}

func (s *Store) GetLake(ctx context.Context, id string) (Lake, error) {
	return scanLake(s.db.QueryRowContext(ctx, `SELECT id, name, description, created_at, updated_at FROM lake WHERE id = ?`, id))
}

func (s *Store) GetLakeByName(ctx context.Context, name string) (Lake, error) {
	return scanLake(s.db.QueryRowContext(ctx, `SELECT id, name, description, created_at, updated_at FROM lake WHERE name = ?`, name))
}

func (s *Store) ListLakes(ctx context.Context) ([]Lake, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, name, description, created_at, updated_at FROM lake ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Lake
	for rows.Next() {
		lake, err := scanLake(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, lake)
	}
	return out, rows.Err()
}

// ListLakeResourceCounts returns a global summary without loading individual resources.
func (s *Store) ListLakeResourceCounts(ctx context.Context) ([]LakeResourceCount, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT l.name, l.description, COUNT(r.id)
		FROM lake l LEFT JOIN resource r ON r.lake_id = l.id
		GROUP BY l.id ORDER BY l.name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []LakeResourceCount
	for rows.Next() {
		var item LakeResourceCount
		if err := rows.Scan(&item.Name, &item.Description, &item.ResourceCount); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

// UseLake selects a persistent default for short resource paths. It does not
// authorize operations; callers must still enforce their frozen anchor.
func (s *Store) UseLake(ctx context.Context, id string) error {
	return useLake(ctx, s.db, id)
}

func useLake(ctx context.Context, db sqlWriter, id string) error {
	result, err := db.ExecContext(ctx, `UPDATE current_lake SET lake_id = ? WHERE singleton = 1 AND EXISTS (SELECT 1 FROM lake WHERE id = ?)`, id, id)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) CurrentLake(ctx context.Context) (Lake, error) {
	lake, err := scanLake(s.db.QueryRowContext(ctx, `SELECT l.id, l.name, l.description, l.created_at, l.updated_at FROM current_lake c JOIN lake l ON l.id = c.lake_id WHERE c.singleton = 1`))
	if errors.Is(err, ErrNotFound) {
		return Lake{}, ErrNoCurrentLake
	}
	return lake, err
}

type scanner interface{ Scan(...any) error }

func scanLake(row scanner) (Lake, error) {
	var lake Lake
	var created, updated int64
	err := row.Scan(&lake.ID, &lake.Name, &lake.Description, &created, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return Lake{}, ErrNotFound
	}
	if err != nil {
		return Lake{}, err
	}
	lake.CreatedAt, lake.UpdatedAt = fromMillis(created), fromMillis(updated)
	return lake, nil
}
