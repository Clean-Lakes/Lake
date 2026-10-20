package ai

import (
	"regexp"
	"strings"
)

var postgresSQLName = regexp.MustCompile(`[\pL\pN_$]*PG_[\pL\pN_$]*`)

// PostgreSQL catalog relations are not administrative functions. Keep a bounded
// set of inspection names instead of treating every PG_ occurrence as a write.
// Unknown names and quoted spellings retain the existing approval requirement.
func readonlyPostgresNames(sql string) bool {
	for _, loc := range postgresSQLName.FindAllStringIndex(sql, -1) {
		start, end := loc[0], loc[1]
		if start > 0 && sql[start-1] == '"' || end < len(sql) && sql[end] == '"' {
			return false
		}
		name := sql[start:end]
		call := strings.HasPrefix(strings.TrimSpace(sql[end:]), "(")
		if call {
			switch name {
			case "PG_DATABASE_SIZE", "PG_SIZE_PRETTY", "PG_SIZE_BYTES", "PG_TABLE_SIZE", "PG_TOTAL_RELATION_SIZE", "PG_RELATION_SIZE", "PG_INDEXES_SIZE", "PG_TABLESPACE_SIZE", "PG_POSTMASTER_START_TIME", "PG_BACKEND_PID", "PG_IS_IN_RECOVERY":
				continue
			}
		} else {
			switch name {
			case "PG_CATALOG":
				// The namespace is not permission for arbitrary admin functions
				// such as pg_catalog.set_config or pg_catalog.lo_import.
				tail := strings.TrimSpace(sql[end:])
				if strings.HasPrefix(tail, ".") && strings.HasPrefix(strings.TrimSpace(tail[1:]), "PG_") {
					continue
				}
			case "PG_DATABASE", "PG_STAT_ACTIVITY", "PG_STAT_DATABASE", "PG_SETTINGS", "PG_LOCKS", "PG_CLASS", "PG_NAMESPACE", "PG_ATTRIBUTE", "PG_TYPE", "PG_INDEX", "PG_INDEXES", "PG_TABLES", "PG_VIEWS", "PG_ROLES", "PG_STAT_USER_TABLES", "PG_STAT_ALL_TABLES", "PG_STAT_REPLICATION", "PG_STAT_WAL_RECEIVER":
				continue
			}
		}
		return false
	}
	return true
}
