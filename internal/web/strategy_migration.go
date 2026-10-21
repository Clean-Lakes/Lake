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

//go:embed strategy_schema.sql
var strategySchema string

//go:embed strategy_learning_schema.sql
var strategyLearningSchema string

// Check before legacy schema/migrations or restart reconciliation can write.
// Binaries predating this guard cannot be made forward-aware retroactively;
// downgrade instructions require an offline compatibility copy, never this DB.
func (s *Store) prepareStrategyMigration() error {
	var name string
	err := s.db.QueryRow("SELECT name FROM sqlite_master WHERE type='table' AND name='strategySchemaMeta'").Scan(&name)
	if err == nil {
		var version int
		var digest string
		if err = s.db.QueryRow("SELECT version,schemaHash FROM strategySchemaMeta").Scan(&version, &digest); err != nil {
			return errors.New("invalid strategy schema marker")
		}
		if (version != 1 || digest != strategySchemaV1Hash()) && (version != 2 || digest != strategySchemaHash()) {
			return errors.New("unsupported strategy schema; use a compatible Lake build")
		}
		if version == 1 {
			backup := filepath.Join(s.Dir, "lake-web.before-strategy-v2-"+ident()+".sqlite")
			if _, err = s.db.Exec("VACUUM INTO ?", backup); err != nil {
				return err
			}
			return platform.Chmod(backup, 0600)
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
	backup := filepath.Join(s.Dir, "lake-web.before-strategy-v1-"+ident()+".sqlite")
	if _, err = s.db.Exec("VACUUM INTO ?", backup); err != nil {
		return err
	}
	return platform.Chmod(backup, 0600)
}
func (s *Store) migrateStrategy() error {
	var version int
	err := s.db.QueryRow("SELECT version FROM strategySchemaMeta").Scan(&version)
	if err == nil && version == 2 {
		return nil
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if version == 0 {
		if _, err = tx.Exec(strategySchema); err != nil {
			return err
		}
		if _, err = tx.Exec("INSERT INTO strategySchemaMeta VALUES(1,?)", strategySchemaV1Hash()); err != nil {
			return err
		}
	}
	if _, err = tx.Exec(strategyLearningSchema); err != nil {
		return err
	}
	// V1 pins CHECK(version=1). Replace only the marker inside this transaction.
	if _, err = tx.Exec("DROP TABLE strategySchemaMeta; CREATE TABLE strategySchemaMeta(version INTEGER NOT NULL CHECK(version=2),schemaHash TEXT NOT NULL)"); err != nil {
		return err
	}
	if _, err = tx.Exec("INSERT INTO strategySchemaMeta VALUES(2,?)", strategySchemaHash()); err != nil {
		return err
	}
	return tx.Commit()
}

// Git may check text out with CRLF on Windows; line endings are not a DB format change.
func strategySchemaV1Hash() string {
	return strategy.ContentHash(strings.ReplaceAll(strategySchema, "\r\n", "\n"))
}

func strategySchemaHash() string {
	return strategy.ContentHash(strategySchemaV1Hash() + "\n" + strings.ReplaceAll(strategyLearningSchema, "\r\n", "\n"))
}
