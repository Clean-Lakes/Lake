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
	"errors"
	"fmt"
	"time"
)

type Link struct {
	FromID    string
	ToID      string
	Type      string
	CreatedAt time.Time
}

func (s *Store) AddLink(ctx context.Context, fromID, toID, linkType string) (Link, error) {
	if fromID == toID {
		return Link{}, errors.New("resource cannot link to itself")
	}
	switch linkType {
	case "depends_on", "part_of", "connects_to":
	default:
		return Link{}, fmt.Errorf("unknown link type %q", linkType)
	}
	now := nowMillis()
	_, err := s.db.ExecContext(ctx, `INSERT INTO link(from_id, to_id, type, created_at) VALUES (?, ?, ?, ?)`, fromID, toID, linkType, now)
	if err != nil {
		return Link{}, err
	}
	return Link{FromID: fromID, ToID: toID, Type: linkType, CreatedAt: fromMillis(now)}, nil
}

func (s *Store) ListLinks(ctx context.Context, resourceID string) ([]Link, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT from_id, to_id, type, created_at FROM link WHERE from_id = ? OR to_id = ? ORDER BY type, from_id, to_id`, resourceID, resourceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Link
	for rows.Next() {
		var link Link
		var created int64
		if err := rows.Scan(&link.FromID, &link.ToID, &link.Type, &created); err != nil {
			return nil, err
		}
		link.CreatedAt = fromMillis(created)
		out = append(out, link)
	}
	return out, rows.Err()
}
