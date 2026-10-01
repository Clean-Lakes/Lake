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
	"strings"
	"time"
)

type JournalInput struct {
	RunID      string
	ActionID   string
	Actor      string
	TargetPath string
	Tool       string
	Risk       string
	Event      string
	Detail     string
	ExitCode   *int
	DurationMS *int64
}

type JournalEntry struct {
	ID        int64
	Timestamp time.Time
	JournalInput
}

type JournalFilter struct {
	RunID      string
	ActionID   string
	TargetPath string
	Limit      int
}

func NewActionID() (string, error) { return newID() }

// AppendJournal adds one event. The database rejects UPDATE and DELETE on
// journal; related events share an ActionID and remain individually visible.
func (s *Store) AppendJournal(ctx context.Context, in JournalInput) (JournalEntry, error) {
	return appendJournal(ctx, s.db, in)
}

func appendJournal(ctx context.Context, db sqlWriter, in JournalInput) (JournalEntry, error) {
	if in.ActionID == "" {
		return JournalEntry{}, errors.New("action ID is required")
	}
	if in.TargetPath == "" || in.Tool == "" {
		return JournalEntry{}, errors.New("journal target and tool are required")
	}
	if in.Actor != "cli" && in.Actor != "agent" {
		return JournalEntry{}, fmt.Errorf("invalid journal actor %q", in.Actor)
	}
	switch in.Risk {
	case "none", "read", "write", "block":
	default:
		return JournalEntry{}, fmt.Errorf("invalid risk %q", in.Risk)
	}
	switch in.Event {
	case "requested", "proposed", "approved", "started", "completed", "denied", "failed", "unknown":
	default:
		return JournalEntry{}, fmt.Errorf("invalid journal event %q", in.Event)
	}
	if len(in.Detail) > 16384 {
		return JournalEntry{}, errors.New("journal detail exceeds 16 KiB")
	}
	now := nowMillis()
	result, err := db.ExecContext(ctx, `INSERT INTO journal(ts, run_id, action_id, actor, target_path, tool, risk, event, detail, exit_code, duration_ms)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, now, nullString(in.RunID), in.ActionID, in.Actor, in.TargetPath, in.Tool, in.Risk, in.Event, in.Detail, in.ExitCode, in.DurationMS)
	if err != nil {
		return JournalEntry{}, err
	}
	id, err := result.LastInsertId()
	if err != nil {
		return JournalEntry{}, err
	}
	return JournalEntry{ID: id, Timestamp: fromMillis(now), JournalInput: in}, nil
}

func (s *Store) ListJournal(ctx context.Context, filter JournalFilter) ([]JournalEntry, error) {
	limit := filter.Limit
	if limit == 0 {
		limit = 100
	}
	if limit < 0 || limit > 1000 {
		return nil, errors.New("journal limit must be 1 to 1000")
	}
	query := `SELECT id, ts, run_id, action_id, actor, target_path, tool, risk, event, detail, exit_code, duration_ms FROM journal WHERE 1 = 1`
	var args []any
	if filter.RunID != "" {
		query += ` AND run_id = ?`
		args = append(args, filter.RunID)
	}
	if filter.ActionID != "" {
		query += ` AND action_id = ?`
		args = append(args, filter.ActionID)
	}
	if filter.TargetPath != "" {
		query += ` AND target_path = ?`
		args = append(args, filter.TargetPath)
	}
	query += ` ORDER BY id DESC LIMIT ?`
	args = append(args, limit)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []JournalEntry
	for rows.Next() {
		var entry JournalEntry
		var ts int64
		var runID sql.NullString
		var exitCode sql.NullInt64
		var duration sql.NullInt64
		if err := rows.Scan(&entry.ID, &ts, &runID, &entry.ActionID, &entry.Actor, &entry.TargetPath, &entry.Tool, &entry.Risk, &entry.Event, &entry.Detail, &exitCode, &duration); err != nil {
			return nil, err
		}
		entry.Timestamp = fromMillis(ts)
		entry.RunID = runID.String
		if exitCode.Valid {
			value := int(exitCode.Int64)
			entry.ExitCode = &value
		}
		if duration.Valid {
			value := duration.Int64
			entry.DurationMS = &value
		}
		out = append(out, entry)
	}
	return out, rows.Err()
}

// ValidateTargetPath is useful to callers before writing operation records.
// A resource journal target uses its full human path; the stable resource ID
// used for authorization is kept by the operation layer separately.
func ValidateTargetPath(path string) error {
	parts := strings.Split(path, "/")
	if len(parts) != 2 {
		return fmt.Errorf("target path must be 湖/资源: %q", path)
	}
	for _, part := range parts {
		if err := validName(part); err != nil {
			return err
		}
	}
	return nil
}
