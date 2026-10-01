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

type Patrol struct {
	RunID      string
	Prompt     string
	Status     string
	StartedAt  time.Time
	FinishedAt *time.Time
}

func (s *Store) StartPatrol(ctx context.Context, prompt string) (Patrol, error) {
	if prompt == "" {
		return Patrol{}, errors.New("patrol prompt is required")
	}
	id, err := newID()
	if err != nil {
		return Patrol{}, err
	}
	now := nowMillis()
	_, err = s.db.ExecContext(ctx, `INSERT INTO patrol(run_id, prompt, status, started_at) VALUES (?, ?, 'running', ?)`, id, prompt, now)
	if err != nil {
		return Patrol{}, err
	}
	return Patrol{RunID: id, Prompt: prompt, Status: "running", StartedAt: fromMillis(now)}, nil
}

func (s *Store) FinishPatrol(ctx context.Context, runID, status string) (Patrol, error) {
	switch status {
	case "completed", "failed", "unknown":
	default:
		return Patrol{}, fmt.Errorf("invalid terminal patrol status %q", status)
	}
	result, err := s.db.ExecContext(ctx, `UPDATE patrol SET status = ?, finished_at = ? WHERE run_id = ? AND status = 'running'`, status, nowMillis(), runID)
	if err != nil {
		return Patrol{}, err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return Patrol{}, err
	}
	if n == 0 {
		return Patrol{}, ErrNotFound
	}
	return s.GetPatrol(ctx, runID)
}

func (s *Store) GetPatrol(ctx context.Context, runID string) (Patrol, error) {
	var patrol Patrol
	var started int64
	var finished sql.NullInt64
	err := s.db.QueryRowContext(ctx, `SELECT run_id, prompt, status, started_at, finished_at FROM patrol WHERE run_id = ?`, runID).Scan(&patrol.RunID, &patrol.Prompt, &patrol.Status, &started, &finished)
	if errors.Is(err, sql.ErrNoRows) {
		return Patrol{}, ErrNotFound
	}
	if err != nil {
		return Patrol{}, err
	}
	patrol.StartedAt = fromMillis(started)
	if finished.Valid {
		value := fromMillis(finished.Int64)
		patrol.FinishedAt = &value
	}
	return patrol, nil
}
