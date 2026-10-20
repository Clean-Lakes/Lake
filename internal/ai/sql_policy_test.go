package ai

import "testing"

func TestPostgresQueryPermissionClassification(t *testing.T) {
	reads := []string{
		"SELECT count(*) FROM pg_stat_activity",
		"SELECT count(*) FROM pg_catalog.pg_stat_activity;",
		"SELECT datname FROM pg_database WHERE datallowconn",
		"SELECT datname, pg_size_pretty(pg_database_size(datname)) FROM pg_database",
		"SELECT version(), now(), pg_postmaster_start_time(), current_setting('server_version'), (SELECT count(*) FROM pg_stat_activity)",
		"select pg_catalog.pg_database_size(current_database())",
		"SELECT pg_relation_size('sample'), pg_table_size('sample'), pg_total_relation_size('sample'), pg_indexes_size('sample')",
		"SELECT pg_size_bytes('1 GB'), pg_tablespace_size(1663), pg_backend_pid(), pg_is_in_recovery()",
		"SELECT * FROM pg_settings",
	}
	writes := []string{
		"UPDATE sample SET value=1", "DELETE FROM sample", "DROP TABLE sample",
		"SELECT 1; DELETE FROM sample", "SELECT * INTO sample FROM pg_database",
		"SELECT * FROM pg_stat_activity FOR UPDATE",
		"SELECT pg_read_file('/example')", "SELECT pg_read_binary_file('/example')",
		"SELECT pg_terminate_backend(42)", "SELECT pg_cancel_backend(42)",
		"SELECT pg_reload_conf()", "SELECT pg_rotate_logfile()", "SELECT pg_switch_wal()",
		"SELECT pg_advisory_lock(1)", "SELECT pg_sleep (1)",
		"SELECT pg_catalog.pg_terminate_backend(42)", "SELECT pg_unknown_action()",
		"SELECT pg_catalog.lo_import('/example')", "SELECT pg_catalog.set_config('work_mem', '64MB', false)",
		`SELECT "pg_read_file"('/example')`, `SELECT "pg_database"()`,
		"SELECT pg_database()", "SELECT pg_stat_activity()",
		"SELECT custom_pg_database_size()", "SELECT épg_database_size()", "SELECT pg_databaseé()",
		"SELECT pg_database_size /* comment */ (1)",
	}
	for _, test := range []struct {
		sqls []string
		risk string
	}{{reads, "readonly"}, {writes, "write"}} {
		for _, query := range test.sqls {
			t.Run(query, func(t *testing.T) {
				risk := ToolRisk("execute_sql", map[string]any{"sql": query})
				if risk != test.risk {
					t.Fatalf("got risk %q, want %q", risk, test.risk)
				}
				for _, silent := range []bool{true, false} {
					p := DefaultPermissions()
					p.SilentReadSQL = silent
					approval, err := RequiresApproval(Config{Permissions: &p}, "execute_sql", risk, nil)
					if err != nil || approval != (!silent || test.risk != "readonly") {
						t.Fatalf("silent=%v: approval=%v err=%v", silent, approval, err)
					}
				}
			})
		}
	}
}
