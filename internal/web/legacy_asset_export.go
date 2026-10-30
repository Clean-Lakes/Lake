package web

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/Clean-Lakes/Lake/internal/platform"
)

// ExportLegacyAssets reads one consistent, local archive snapshot. It never
// opens Store, runs recovery, replays a receipt or contacts a model. Content is
// read from the original rows so source withdrawal also applies to this export;
// previously exported files, like backups, remain the owner's responsibility.
func ExportLegacyAssets(ctx context.Context, dataDir, output string) (err error) {
	path := filepath.Join(dataDir, "lake-web.sqlite")
	info, e := os.Lstat(path)
	if e != nil || !info.Mode().IsRegular() || !platform.Private(path, info) {
		return errors.New("private Lake database unavailable")
	}
	db, e := openSQLiteReadOnly(path)
	if e != nil {
		return errors.New("archive unavailable")
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	if _, e = db.ExecContext(ctx, "PRAGMA query_only=ON"); e != nil {
		return e
	}
	tx, e := db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if e != nil {
		return e
	}
	defer tx.Rollback()
	var version int
	var digest string
	if e = tx.QueryRowContext(ctx, "SELECT version,schemaHash FROM strategySchemaMeta").Scan(&version, &digest); e != nil || version != 7 || digest != strategyArchiveSchemaHash() {
		return errors.New("start a compatible Lake build once to archive legacy assets")
	}
	// Static schema allowlist, not arbitrary database tables or user-controlled SQL.
	tables := []string{"legacyAssetArchive", "legacyAssetSettingsArchive", "naturalMemoryLinks", "naturalMemoryChanges"}
	for _, ddl := range []string{strategySchema, strategyLearningSchema, strategyExperimentSchema, strategyOptimizationSchema, strategyReviewSchema, strategyReuseSchema} {
		for _, line := range strings.Split(ddl, "\n") {
			if strings.HasPrefix(line, "CREATE TABLE ") {
				name := strings.Fields(strings.TrimPrefix(line, "CREATE TABLE "))[0]
				name = strings.Split(name, "(")[0]
				tables = append(tables, name)
			}
		}
	}
	// Exclusive final link never replaces a file or follows an output symlink.
	file, e := os.CreateTemp(filepath.Dir(output), ".lake-retired-assets-*.tmp")
	if e != nil {
		return errors.New("archive output unavailable")
	}
	temp := file.Name()
	defer os.Remove(temp)
	defer file.Close()
	if e = platform.Chmod(temp, 0600); e != nil {
		return e
	}
	if _, e = io.WriteString(file, `{"format":"lake-retired-assets","version":1,"runtimeUse":false,"tables":{`); e != nil {
		return e
	}
	encoder := json.NewEncoder(file)
	for i, table := range tables {
		if i > 0 {
			if _, e = io.WriteString(file, ","); e != nil {
				return e
			}
		}
		key, _ := json.Marshal(table)
		if _, e = fmt.Fprintf(file, "%s:[", key); e != nil {
			return e
		}
		rows, e := tx.QueryContext(ctx, `SELECT * FROM "`+table+`" ORDER BY rowid`)
		if e != nil {
			return errors.New("archive table unavailable")
		}
		e = exportLegacyRows(file, encoder, rows)
		rows.Close()
		if e != nil {
			return e
		}
		if _, e = io.WriteString(file, "]"); e != nil {
			return e
		}
	}
	if _, e = io.WriteString(file, "}}\n"); e != nil {
		return e
	}
	if e = tx.Commit(); e != nil {
		return e
	}
	if e = file.Sync(); e != nil {
		return e
	}
	if e = file.Close(); e != nil {
		return e
	}
	if e = os.Link(temp, output); e != nil {
		return errors.New("archive output already exists or cannot be created")
	}
	return platform.SyncDirectory(filepath.Dir(output))
}
func exportLegacyRows(w io.Writer, enc *json.Encoder, rows *sql.Rows) error {
	cols, e := rows.Columns()
	if e != nil {
		return e
	}
	first := true
	for rows.Next() {
		values := make([]any, len(cols))
		dest := make([]any, len(cols))
		for i := range values {
			dest[i] = &values[i]
		}
		if e = rows.Scan(dest...); e != nil {
			return e
		}
		row := make(map[string]any, len(cols))
		for i, c := range cols {
			if b, ok := values[i].([]byte); ok {
				values[i] = string(b)
			}
			row[c] = values[i]
		}
		if !first {
			if _, e = io.WriteString(w, ","); e != nil {
				return e
			}
		}
		first = false
		if e = enc.Encode(row); e != nil {
			return e
		}
	}
	return rows.Err()
}
