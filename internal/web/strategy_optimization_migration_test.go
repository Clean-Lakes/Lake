package web

import (
	"path/filepath"
	"testing"
)

func TestStrategyOptimizationV3MigrationBackupAndRollback(t *testing.T) {
	for _, conflict := range []bool{false, true} {
		t.Run(map[bool]string{false: "upgrade", true: "rollback"}[conflict], func(t *testing.T) {
			dir := t.TempDir()
			db, err := openSQLite(filepath.Join(dir, "lake-web.sqlite"))
			if err != nil {
				t.Fatal(err)
			}
			for _, ddl := range []string{schema, presentationSchema, memorySchema, strategySchema, strategyLearningSchema, strategyExperimentSchema} {
				if _, err = db.Exec(ddl); err != nil {
					t.Fatal(err)
				}
			}
			_, err = db.Exec("DROP TABLE strategySchemaMeta;CREATE TABLE strategySchemaMeta(version INTEGER PRIMARY KEY CHECK(version=3),schemaHash TEXT NOT NULL);INSERT INTO strategySchemaMeta VALUES(3,?)", strategySchemaV3Hash())
			if err != nil {
				t.Fatal(err)
			}
			if conflict {
				_, err = db.Exec("CREATE TABLE strategyOptimizationCalls(conflict INTEGER)")
				if err != nil {
					t.Fatal(err)
				}
			}
			db.Close()
			s, openErr := OpenStore(dir)
			if conflict {
				if openErr == nil {
					s.Close()
					t.Fatal("partial v4 accepted")
				}
			} else {
				if openErr != nil {
					t.Fatal(openErr)
				}
				s.Close()
			}
			backups, _ := filepath.Glob(filepath.Join(dir, "lake-web.before-strategy-v4-*.sqlite"))
			if len(backups) != 1 {
				t.Fatal("missing private v3 backup")
			}
			old, _ := openSQLite(backups[0])
			var version int
			old.QueryRow("SELECT version FROM strategySchemaMeta").Scan(&version)
			old.Close()
			if version != 3 {
				t.Fatal("backup is not v3")
			}
			db, _ = openSQLite(filepath.Join(dir, "lake-web.sqlite"))
			defer db.Close()
			db.QueryRow("SELECT version FROM strategySchemaMeta").Scan(&version)
			want := 4
			if conflict {
				want = 3
			}
			if version != want {
				t.Fatal("nontransactional marker", version)
			}
			var count int
			db.QueryRow("SELECT count(*) FROM pragma_table_info('strategyExperimentRuns') WHERE name='variant'").Scan(&count)
			if count != map[bool]int{false: 1, true: 0}[conflict] {
				t.Fatal("partial ALTER TABLE survived", count)
			}
			if !conflict {
				s, err = OpenStore(dir)
				if err != nil {
					t.Fatal(err)
				}
				s.Close()
				backups, _ = filepath.Glob(filepath.Join(dir, "lake-web.before-strategy-v4-*.sqlite"))
				if len(backups) != 1 {
					t.Fatal("duplicate backup")
				}
			}
		})
	}
}
