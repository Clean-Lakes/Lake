// Package storage owns Lake's private, official ADK session database and the
// adjacent application tables. It has no dependency on the Lake AI domain.
package storage

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"github.com/Clean-Lakes/Lake/internal/platform"
	"google.golang.org/adk/v2/session"
	sessiondb "google.golang.org/adk/v2/session/database"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
	_ "modernc.org/sqlite"
)

type Store struct {
	backupMu sync.Mutex
	Sessions session.Service
	DB       *gorm.DB
	SQL      *sql.DB
}

func Open(path string) (*Store, error) {
	dir := filepath.Dir(path)
	if err := platform.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	if err := platform.Chmod(dir, 0700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = f.Close(); err != nil {
		return nil, err
	}
	if err = platform.Chmod(path, 0600); err != nil {
		return nil, err
	}
	// Lake's Windows store already registers modernc's "sqlite" driver.
	// Use the same pure-Go driver through GORM's public SQLite dialector;
	// glebarez/go-sqlite would register that name a second time at process init.
	raw, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db, err := gorm.Open(sqlite.New(sqlite.Config{DriverName: "sqlite", Conn: raw}), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		raw.Close()
		return nil, fmt.Errorf("open private ADK database: %w", err)
	}
	raw.SetMaxOpenConns(1)
	fail := func(err error) (*Store, error) { raw.Close(); return nil, err }
	if _, err = raw.Exec("PRAGMA busy_timeout=10000"); err != nil {
		return fail(err)
	}
	if _, err = raw.Exec("PRAGMA synchronous=FULL"); err != nil {
		return fail(err)
	}
	service, err := sessiondb.NewSessionServiceFromDB(db)
	if err != nil {
		return fail(err)
	}
	if err = sessiondb.AutoMigrate(service); err != nil {
		return fail(err)
	}
	return &Store{Sessions: service, DB: db, SQL: raw}, nil
}

func (s *Store) Close() error { return s.SQL.Close() }

// Backup uses SQLite's consistent snapshot operation, including committed WAL
// content. A raw copy of an open database file would not provide that guarantee.
func (s *Store) Backup(ctx context.Context, path string) error {
	s.backupMu.Lock()
	defer s.backupMu.Unlock()
	if info, err := os.Stat(path); err == nil && info.Size() > 0 {
		return nil
	} else if err != nil && !os.IsNotExist(err) {
		return err
	}
	if err := platform.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	temp, err := os.CreateTemp(filepath.Dir(path), ".sqlite-snapshot-*")
	if err != nil {
		return err
	}
	name := temp.Name()
	defer os.Remove(name)
	if err = platform.Chmod(name, 0600); err != nil {
		temp.Close()
		return err
	}
	if err = temp.Close(); err != nil {
		return err
	}
	if _, err = s.SQL.ExecContext(ctx, "VACUUM INTO ?", name); err != nil {
		return err
	}
	check, err := sql.Open("sqlite", name)
	if err != nil {
		return err
	}
	var verdict string
	err = check.QueryRowContext(ctx, "PRAGMA quick_check").Scan(&verdict)
	check.Close()
	if err != nil {
		return err
	}
	if verdict != "ok" {
		return fmt.Errorf("invalid SQLite snapshot")
	}
	file, err := os.OpenFile(name, os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	err = file.Sync()
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return platform.ReplaceFile(name, path)
}
