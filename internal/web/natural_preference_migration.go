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

// N1's hash remains immutable. Content support has its own additive marker.
//
//go:embed natural_preference_schema.sql
var naturalPreferenceSchema string

func naturalPreferenceSchemaHash() string {
	return strategy.ContentHash(strings.ReplaceAll(naturalPreferenceSchema, "\r\n", "\n"))
}
func (s *Store) prepareNaturalPreferenceMigration() error {
	var name string
	err := s.db.QueryRow("SELECT name FROM sqlite_master WHERE type='table' AND name='naturalPreferenceMeta'").Scan(&name)
	if err == nil {
		var v int
		var hash string
		err = s.db.QueryRow("SELECT version,schemaHash FROM naturalPreferenceMeta").Scan(&v, &hash)
		if err != nil || v != 1 || hash != naturalPreferenceSchemaHash() {
			return errors.New("unsupported natural preference schema; use a compatible Lake build")
		}
		return nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	err = s.db.QueryRow("SELECT name FROM sqlite_master WHERE type='table' AND name='projects'").Scan(&name)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	backup := filepath.Join(s.Dir, "lake-web.before-natural-preference-v1-"+ident()+".sqlite")
	if _, err = s.db.Exec("VACUUM INTO ?", backup); err != nil {
		return err
	}
	return platform.Chmod(backup, 0600)
}
func (s *Store) migrateNaturalPreference() error {
	var v int
	if s.db.QueryRow("SELECT version FROM naturalPreferenceMeta").Scan(&v) == nil && v == 1 {
		return nil
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec(naturalPreferenceSchema); err != nil {
		return err
	}
	if _, err = tx.Exec("INSERT INTO naturalPreferenceMeta VALUES(1,?)", naturalPreferenceSchemaHash()); err != nil {
		return err
	}
	return tx.Commit()
}
