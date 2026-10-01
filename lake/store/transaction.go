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
)

// Mutation groups a data change and its journal event in one SQLite commit.
// A failed callback rolls back both. Keep callbacks short and free of network
// calls or user interaction.
type Mutation struct{ tx *sql.Tx }

func (s *Store) Mutate(ctx context.Context, fn func(*Mutation) error) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := fn(&Mutation{tx: tx}); err != nil {
		return err
	}
	return tx.Commit()
}

type sqlWriter interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func (m *Mutation) CreateLake(ctx context.Context, name, description string) (Lake, error) {
	return createLake(ctx, m.tx, name, description)
}

func (m *Mutation) UseLake(ctx context.Context, id string) error {
	return useLake(ctx, m.tx, id)
}

func (m *Mutation) CreateHost(ctx context.Context, in ResourceInput) (Resource, error) {
	return createHost(ctx, m.tx, in)
}

func (m *Mutation) CreateK8s(ctx context.Context, in ResourceInput) (Resource, error) {
	return createK8s(ctx, m.tx, in)
}

func (m *Mutation) CreateDatabase(ctx context.Context, kind string, in ResourceInput) (Resource, error) {
	return createDatabase(ctx, m.tx, kind, in)
}

func (m *Mutation) SetExecuteAuthz(ctx context.Context, id string, enabled bool) (Resource, error) {
	return setExecuteAuthz(ctx, m.tx, id, enabled)
}

func (m *Mutation) SetPermissionPolicy(ctx context.Context, key string, enabled bool) (PermissionPolicy, error) {
	return setPermissionPolicy(ctx, m.tx, key, enabled)
}

func (m *Mutation) SetCredentialRef(ctx context.Context, resourceID, ref string) (Attachment, error) {
	return setCredentialRef(ctx, m.tx, resourceID, ref)
}

func (m *Mutation) AppendJournal(ctx context.Context, in JournalInput) (JournalEntry, error) {
	return appendJournal(ctx, m.tx, in)
}
