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

// N1/N2 hashes remain immutable. Consolidation has its own additive marker.
//
//go:embed natural_consolidation_schema.sql
var naturalConsolidationSchema string

func naturalConsolidationSchemaHash() string {
	return strategy.ContentHash(strings.ReplaceAll(naturalConsolidationSchema, "\r\n", "\n"))
}
func (s *Store) prepareNaturalConsolidationMigration() error {
	var name string
	err := s.db.QueryRow("SELECT name FROM sqlite_master WHERE type='table' AND name='naturalConsolidationMeta'").Scan(&name)
	if err == nil {
		var v int
		var hash string
		err = s.db.QueryRow("SELECT version,schemaHash FROM naturalConsolidationMeta").Scan(&v, &hash)
		if err != nil || v != 1 || hash != naturalConsolidationSchemaHash() {
			return errors.New("unsupported natural consolidation schema; use a compatible Lake build")
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
	backup := filepath.Join(s.Dir, "lake-web.before-natural-consolidation-v1-"+ident()+".sqlite")
	if _, err = s.db.Exec("VACUUM INTO ?", backup); err != nil {
		return err
	}
	return platform.Chmod(backup, 0600)
}
func (s *Store) migrateNaturalConsolidation() error {
	var v int
	if s.db.QueryRow("SELECT version FROM naturalConsolidationMeta").Scan(&v) == nil && v == 1 {
		return nil
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec(naturalConsolidationSchema); err != nil {
		return err
	}
	if _, err = tx.Exec("INSERT INTO naturalConsolidationMeta VALUES(1,?)", naturalConsolidationSchemaHash()); err != nil {
		return err
	}
	// Existing N2 revisions contribute source references; bodies are not duplicated.
	if _, err = tx.Exec("INSERT INTO naturalPreferenceSupports SELECT r.entryId,r.revision,r.sourceProject,r.sourceSession,r.sourceMessage,r.sourceHash,r.revision FROM naturalPreferenceRevisions r JOIN naturalPreferenceContent c ON c.entryId=r.entryId AND c.revision=r.revision"); err != nil {
		return err
	}
	return tx.Commit()
}
