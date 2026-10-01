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

// Package store owns Lake's local operations data. It has no Agent or SSH
// dependency; callers use stable IDs returned here to select resources.
package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

var (
	ErrNotFound      = errors.New("lake: not found")
	ErrNoCurrentLake = errors.New("lake: no current lake")
)

const schemaVersion = 19

// Store owns one SQLite database under root. Open with an empty root to use
// ~/.lake. Call Close when finished.
type Store struct {
	db   *sql.DB
	root string
}

func Open(ctx context.Context, root string) (*Store, error) {
	if root == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil, fmt.Errorf("find home directory: %w", err)
		}
		root = filepath.Join(home, ".lake")
	}
	var err error
	root, err = filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	for _, dir := range []string{root, filepath.Join(root, "scripts"), filepath.Join(root, "keys")} {
		if err := os.MkdirAll(dir, 0700); err != nil {
			return nil, fmt.Errorf("create %s: %w", dir, err)
		}
		if err := os.Chmod(dir, 0700); err != nil {
			return nil, fmt.Errorf("protect %s: %w", dir, err)
		}
	}
	path := filepath.Join(root, "lake.db")
	if info, err := os.Lstat(path); err == nil && info.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("database path is a symlink: %s", path)
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, fmt.Errorf("open database file: %w", err)
	}
	if err := file.Chmod(0600); err != nil {
		file.Close()
		return nil, err
	}
	if err := file.Close(); err != nil {
		return nil, err
	}
	dsn := &url.URL{Scheme: "file", Path: path}
	query := url.Values{}
	query.Add("_pragma", "foreign_keys(1)")
	query.Add("_pragma", "busy_timeout(5000)")
	dsn.RawQuery = query.Encode()
	db, err := sql.Open("sqlite", dsn.String())
	if err != nil {
		return nil, err
	}
	// The DSN applies foreign keys and busy timeout to every new connection.
	db.SetMaxOpenConns(1)
	s := &Store{db: db, root: root}
	if err := s.initialize(ctx); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) Root() string { return s.root }

func (s *Store) initialize(ctx context.Context) error {
	var foreignKeys int
	if err := s.db.QueryRowContext(ctx, "PRAGMA foreign_keys").Scan(&foreignKeys); err != nil {
		return fmt.Errorf("check SQLite foreign keys: %w", err)
	}
	if foreignKeys != 1 {
		return errors.New("SQLite foreign keys are disabled")
	}
	var version int
	if err := s.db.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil {
		return err
	}
	if version > schemaVersion {
		return fmt.Errorf("database schema %d is newer than supported schema %d", version, schemaVersion)
	}
	if version == schemaVersion {
		return nil
	}
	// VACUUM INTO cannot run inside the migration transaction. Create a
	// private, consistent snapshot before changing any pre-v8 database.
	if version > 0 && version < 8 {
		if err := s.backupBeforeV8(ctx); err != nil {
			return fmt.Errorf("back up database before v8 migration: %w", err)
		}
	}
	if version == 8 {
		if err := s.backupBeforeVersion(ctx, "v9"); err != nil {
			return fmt.Errorf("back up database before v9 migration: %w", err)
		}
	}
	if version == 9 {
		if err := s.backupBeforeVersion(ctx, "v10"); err != nil {
			return fmt.Errorf("back up database before v10 migration: %w", err)
		}
	}
	if version == 10 {
		if err := s.backupBeforeVersion(ctx, "v11"); err != nil {
			return fmt.Errorf("back up database before v11 migration: %w", err)
		}
	}
	if version == 11 {
		if err := s.backupBeforeVersion(ctx, "v12"); err != nil {
			return fmt.Errorf("back up database before v12 migration: %w", err)
		}
	}
	if version == 12 {
		if err := s.backupBeforeVersion(ctx, "v13"); err != nil {
			return fmt.Errorf("back up database before v13 migration: %w", err)
		}
	}
	if version == 13 {
		if err := s.backupBeforeVersion(ctx, "v14"); err != nil {
			return fmt.Errorf("back up database before v14 migration: %w", err)
		}
	}
	if version == 14 {
		if err := s.backupBeforeVersion(ctx, "v15"); err != nil {
			return fmt.Errorf("back up database before v15 migration: %w", err)
		}
	}
	if version == 15 {
		if err := s.backupBeforeVersion(ctx, "v16"); err != nil {
			return fmt.Errorf("back up database before v16 migration: %w", err)
		}
	}
	if version == 16 {
		if err := s.backupBeforeVersion(ctx, "v17"); err != nil {
			return fmt.Errorf("back up database before v17 migration: %w", err)
		}
	}
	if version == 17 {
		if err := s.backupBeforeVersion(ctx, "v18"); err != nil {
			return fmt.Errorf("back up database before v18 migration: %w", err)
		}
	}
	if version == 18 {
		if err := s.backupBeforeVersion(ctx, "v19"); err != nil {
			return fmt.Errorf("back up database before v19 migration: %w", err)
		}
	}
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		return err
	}
	defer conn.ExecContext(context.Background(), "ROLLBACK")
	// Other Lake processes may have migrated while we waited for the write lock.
	if err := conn.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil {
		return err
	}
	if version > schemaVersion {
		return fmt.Errorf("database schema %d is newer than supported schema %d", version, schemaVersion)
	}
	if version == 0 {
		if _, err := conn.ExecContext(ctx, migrationV1); err != nil {
			return fmt.Errorf("migrate schema v1: %w", err)
		}
		version = 1
	}
	if version == 1 {
		if _, err := conn.ExecContext(ctx, migrationV2); err != nil {
			return fmt.Errorf("migrate schema v2: %w", err)
		}
		version = 2
	}
	if version == 2 {
		if _, err := conn.ExecContext(ctx, migrationV3); err != nil {
			return fmt.Errorf("migrate schema v3: %w", err)
		}
		version = 3
	}
	if version == 3 {
		if _, err := conn.ExecContext(ctx, migrationV4); err != nil {
			return fmt.Errorf("migrate schema v4: %w", err)
		}
		version = 4
	}
	if version == 4 {
		if _, err := conn.ExecContext(ctx, migrationV5); err != nil {
			return fmt.Errorf("migrate schema v5: %w", err)
		}
		version = 5
	}
	if version == 5 {
		if _, err := conn.ExecContext(ctx, migrationV6); err != nil {
			return fmt.Errorf("migrate schema v6: %w", err)
		}
		version = 6
	}
	if version == 6 {
		if _, err := conn.ExecContext(ctx, migrationV7); err != nil {
			return fmt.Errorf("migrate schema v7: %w", err)
		}
		version = 7
	}
	if version == 7 {
		if _, err := conn.ExecContext(ctx, migrationV8); err != nil {
			return fmt.Errorf("migrate schema v8: %w", err)
		}
		if _, err := conn.ExecContext(ctx, migrationV8Backfill); err != nil {
			return fmt.Errorf("backfill conversation events: %w", err)
		}
		version = 8
	}
	if _, err := conn.ExecContext(ctx, fmt.Sprintf("PRAGMA user_version = %d", version)); err != nil {
		return err
	}
	if _, err = conn.ExecContext(ctx, "COMMIT"); err != nil {
		return err
	}
	if err := conn.Close(); err != nil {
		return err
	}
	if err := s.migrateV9(ctx); err != nil {
		return err
	}
	if err := s.migrateV10(ctx); err != nil {
		return err
	}
	if err := s.migrateV11(ctx); err != nil {
		return err
	}
	if err := s.migrateV12(ctx); err != nil {
		return err
	}
	if err := s.migrateV13(ctx); err != nil {
		return err
	}
	if err := s.migrateV14(ctx); err != nil {
		return err
	}
	if err := s.migrateV15(ctx); err != nil {
		return err
	}
	if err := s.migrateV16(ctx); err != nil {
		return err
	}
	if err := s.migrateV17(ctx); err != nil {
		return err
	}
	if err := s.migrateV18(ctx); err != nil {
		return err
	}
	return s.migrateV19(ctx)
}

func (s *Store) migrateV16(ctx context.Context) error {
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		return err
	}
	defer conn.ExecContext(context.Background(), "ROLLBACK")
	var version int
	if err := conn.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil {
		return err
	}
	if version >= 16 {
		_, err = conn.ExecContext(ctx, "COMMIT")
		return err
	}
	if version != 15 {
		return fmt.Errorf("unexpected schema version before v16: %d", version)
	}
	if _, err := conn.ExecContext(ctx, migrationV16); err != nil {
		return fmt.Errorf("migrate schema v16: %w", err)
	}
	if _, err := conn.ExecContext(ctx, "PRAGMA user_version = 16"); err != nil {
		return err
	}
	_, err = conn.ExecContext(ctx, "COMMIT")
	return err
}

func (s *Store) migrateV15(ctx context.Context) error {
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		return err
	}
	defer conn.ExecContext(context.Background(), "ROLLBACK")
	var version int
	if err := conn.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil {
		return err
	}
	if version >= 15 {
		_, err = conn.ExecContext(ctx, "COMMIT")
		return err
	}
	if version != 14 {
		return fmt.Errorf("unexpected schema version before v15: %d", version)
	}
	if _, err := conn.ExecContext(ctx, migrationV15); err != nil {
		return fmt.Errorf("migrate schema v15: %w", err)
	}
	if _, err := conn.ExecContext(ctx, "PRAGMA user_version = 15"); err != nil {
		return err
	}
	_, err = conn.ExecContext(ctx, "COMMIT")
	return err
}

func (s *Store) migrateV14(ctx context.Context) error {
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		return err
	}
	defer conn.ExecContext(context.Background(), "ROLLBACK")
	var version int
	if err := conn.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil {
		return err
	}
	if version >= 14 {
		_, err = conn.ExecContext(ctx, "COMMIT")
		return err
	}
	if version != 13 {
		return fmt.Errorf("unexpected schema version before v14: %d", version)
	}
	if _, err := conn.ExecContext(ctx, migrationV14); err != nil {
		return fmt.Errorf("migrate schema v14: %w", err)
	}
	if _, err := conn.ExecContext(ctx, "PRAGMA user_version = 14"); err != nil {
		return err
	}
	_, err = conn.ExecContext(ctx, "COMMIT")
	return err
}

func (s *Store) migrateV13(ctx context.Context) error {
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		return err
	}
	defer conn.ExecContext(context.Background(), "ROLLBACK")
	var version int
	if err := conn.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil {
		return err
	}
	if version >= 13 {
		_, err = conn.ExecContext(ctx, "COMMIT")
		return err
	}
	if version != 12 {
		return fmt.Errorf("unexpected schema version before v13: %d", version)
	}
	if _, err := conn.ExecContext(ctx, migrationV13); err != nil {
		return fmt.Errorf("migrate schema v13: %w", err)
	}
	if _, err := conn.ExecContext(ctx, "PRAGMA user_version = 13"); err != nil {
		return err
	}
	_, err = conn.ExecContext(ctx, "COMMIT")
	return err
}

func (s *Store) migrateV11(ctx context.Context) error {
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	if _, err = conn.ExecContext(ctx, "PRAGMA foreign_keys = OFF"); err != nil {
		return err
	}
	defer conn.ExecContext(context.Background(), "PRAGMA foreign_keys = ON")
	if _, err = conn.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		return err
	}
	defer conn.ExecContext(context.Background(), "ROLLBACK")
	var version int
	if err = conn.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil {
		return err
	}
	if version >= 11 {
		_, err = conn.ExecContext(ctx, "COMMIT")
		return err
	}
	if version != 10 {
		return fmt.Errorf("unexpected schema version before v11: %d", version)
	}
	if _, err = conn.ExecContext(ctx, migrationV11); err != nil {
		return fmt.Errorf("migrate schema v11: %w", err)
	}
	if _, err = conn.ExecContext(ctx, "PRAGMA user_version = 11"); err != nil {
		return err
	}
	rows, err := conn.QueryContext(ctx, "PRAGMA foreign_key_check")
	if err != nil {
		return err
	}
	if rows.Next() {
		rows.Close()
		return errors.New("v11 migration violates a foreign key")
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	_, err = conn.ExecContext(ctx, "COMMIT")
	return err
}

func (s *Store) migrateV12(ctx context.Context) error {
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		return err
	}
	defer conn.ExecContext(context.Background(), "ROLLBACK")
	var version int
	if err := conn.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil {
		return err
	}
	if version >= 12 {
		_, err = conn.ExecContext(ctx, "COMMIT")
		return err
	}
	if version != 11 {
		return fmt.Errorf("unexpected schema version before v12: %d", version)
	}
	if _, err := conn.ExecContext(ctx, migrationV12); err != nil {
		return fmt.Errorf("migrate schema v12: %w", err)
	}
	if _, err := conn.ExecContext(ctx, "PRAGMA user_version = 12"); err != nil {
		return err
	}
	_, err = conn.ExecContext(ctx, "COMMIT")
	return err
}

func (s *Store) migrateV9(ctx context.Context) error {
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	if _, err = conn.ExecContext(ctx, "PRAGMA foreign_keys = OFF"); err != nil {
		return err
	}
	defer conn.ExecContext(context.Background(), "PRAGMA foreign_keys = ON")
	if _, err = conn.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		return err
	}
	defer conn.ExecContext(context.Background(), "ROLLBACK")
	var version int
	if err = conn.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil {
		return err
	}
	if version >= 9 {
		_, err = conn.ExecContext(ctx, "COMMIT")
		return err
	}
	if version != 8 {
		return fmt.Errorf("unexpected schema version before v9: %d", version)
	}
	if _, err = conn.ExecContext(ctx, migrationV9); err != nil {
		return fmt.Errorf("migrate schema v9: %w", err)
	}
	if _, err = conn.ExecContext(ctx, "PRAGMA user_version = 9"); err != nil {
		return err
	}
	rows, err := conn.QueryContext(ctx, "PRAGMA foreign_key_check")
	if err != nil {
		return err
	}
	if rows.Next() {
		rows.Close()
		return errors.New("v9 migration violates a foreign key")
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	_, err = conn.ExecContext(ctx, "COMMIT")
	return err
}

func (s *Store) migrateV10(ctx context.Context) error {
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		return err
	}
	defer conn.ExecContext(context.Background(), "ROLLBACK")
	var version int
	if err := conn.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil {
		return err
	}
	if version >= 10 {
		_, err = conn.ExecContext(ctx, "COMMIT")
		return err
	}
	if version != 9 {
		return fmt.Errorf("unexpected schema version before v10: %d", version)
	}
	if _, err := conn.ExecContext(ctx, migrationV10); err != nil {
		return fmt.Errorf("migrate schema v10: %w", err)
	}
	if _, err := conn.ExecContext(ctx, "PRAGMA user_version = 10"); err != nil {
		return err
	}
	_, err = conn.ExecContext(ctx, "COMMIT")
	return err
}

func (s *Store) backupBeforeV8(ctx context.Context) error {
	return s.backupBeforeVersion(ctx, "v8")
}

func (s *Store) backupBeforeVersion(ctx context.Context, version string) error {
	file, err := os.CreateTemp(s.root, "lake.db.pre-"+version+"-*.bak")
	if err != nil {
		return err
	}
	path := file.Name()
	if err := file.Close(); err != nil {
		_ = os.Remove(path)
		return err
	}
	if _, err := s.db.ExecContext(ctx, "VACUUM INTO ?", path); err != nil {
		_ = os.Remove(path)
		return err
	}
	if err := os.Chmod(path, 0600); err != nil {
		_ = os.Remove(path)
		return err
	}
	return nil
}

func newID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	// UUID v4: random, stable and independent of display names.
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%s-%s-%s-%s-%s", hex.EncodeToString(b[:4]), hex.EncodeToString(b[4:6]), hex.EncodeToString(b[6:8]), hex.EncodeToString(b[8:10]), hex.EncodeToString(b[10:])), nil
}

func nowMillis() int64 { return time.Now().UTC().UnixMilli() }

func fromMillis(ms int64) time.Time { return time.UnixMilli(ms).UTC() }

func validName(name string) error {
	if name == "" || name != strings.TrimSpace(name) || name == "." || name == ".." || strings.ContainsAny(name, "/\\\x00\n\r") {
		return fmt.Errorf("invalid name %q", name)
	}
	if len(name) > 255 {
		return errors.New("name exceeds 255 bytes")
	}
	return nil
}

// v17 repairs the event column omitted by an early v8 development schema,
// without assuming that every database with the same version has that column.
func (s *Store) migrateV17(ctx context.Context) error {
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		return err
	}
	defer conn.ExecContext(context.Background(), "ROLLBACK")
	var version int
	if err := conn.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil {
		return err
	}
	if version >= 17 {
		_, err = conn.ExecContext(ctx, "COMMIT")
		return err
	}
	if version != 16 {
		return fmt.Errorf("unexpected schema version before v17: %d", version)
	}
	rows, err := conn.QueryContext(ctx, "PRAGMA table_info(conversation_event)")
	if err != nil {
		return err
	}
	found := false
	columns := 0
	for rows.Next() {
		var cid, notnull, pk int
		var name, kind string
		var defaultValue any
		if err := rows.Scan(&cid, &name, &kind, &notnull, &defaultValue, &pk); err != nil {
			rows.Close()
			return err
		}
		columns++
		if name == "tool_call_id" {
			found = true
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if columns == 0 {
		return errors.New("conversation_event table missing before v17")
	}
	if !found {
		if _, err := conn.ExecContext(ctx, `ALTER TABLE conversation_event ADD COLUMN tool_call_id TEXT NOT NULL DEFAULT ''`); err != nil {
			return fmt.Errorf("migrate event column v17: %w", err)
		}
	}
	if _, err := conn.ExecContext(ctx, "PRAGMA user_version = 17"); err != nil {
		return err
	}
	_, err = conn.ExecContext(ctx, "COMMIT")
	return err
}
