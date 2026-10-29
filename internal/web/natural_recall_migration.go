package web

import (
	"database/sql"
	_ "embed"
	"errors"
	"path/filepath"
	"strings"

	"github.com/Clean-Lakes/Lake/internal/platform"
	"github.com/Clean-Lakes/Lake/internal/strategy"
)

//go:embed natural_recall_schema.sql
var naturalRecallSchema string

func naturalRecallSchemaHash() string {
	return strategy.ContentHash(strings.ReplaceAll(naturalRecallSchema, "\r\n", "\n"))
}

// Run before any old migrations or recovery writes, under the process lock.
func (s *Store) prepareNaturalRecallMigration() error {
	var name string
	err := s.db.QueryRow("SELECT name FROM sqlite_master WHERE type='table' AND name='naturalRecallMeta'").Scan(&name)
	if err == nil {
		var version int
		var hash string
		if err = s.db.QueryRow("SELECT version,schemaHash FROM naturalRecallMeta").Scan(&version, &hash); err != nil || version != 1 || hash != naturalRecallSchemaHash() {
			return errors.New("unsupported natural recall schema; use a compatible Lake build")
		}
		return nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if err = s.db.QueryRow("SELECT name FROM sqlite_master WHERE type='table' AND name='projects'").Scan(&name); errors.Is(err, sql.ErrNoRows) {
		return nil
	} else if err != nil {
		return err
	}
	backup := filepath.Join(s.Dir, "lake-web.before-natural-recall-v1-"+ident()+".sqlite")
	if _, err = s.db.Exec("VACUUM INTO ?", backup); err != nil {
		return err
	}
	return platform.Chmod(backup, 0600)
}
func (s *Store) migrateNaturalRecall() error {
	var version int
	if err := s.db.QueryRow("SELECT version FROM naturalRecallMeta").Scan(&version); err == nil && version == 1 {
		return nil
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec(naturalRecallSchema); err != nil {
		return err
	}
	if _, err = tx.Exec("INSERT INTO naturalRecallMeta VALUES(1,?)", naturalRecallSchemaHash()); err != nil {
		return err
	}
	return tx.Commit()
}
