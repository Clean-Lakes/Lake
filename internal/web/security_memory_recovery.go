package web

// These schema probes only select existing application-owned metadata. They
// never migrate a Memory schema or publish a recovered Markdown projection.
func (s *Store) memoryColumnsPresent(table string, required ...string) bool {
	if s.row("SELECT name FROM sqlite_master WHERE type='table' AND name=?", table) == nil {
		return false
	}
	columns := map[string]bool{}
	for _, column := range s.rows("PRAGMA table_info(" + table + ")") {
		columns[stringOf(column["name"])] = true
	}
	for _, name := range required {
		if !columns[name] {
			return false
		}
	}
	return true
}

func (s *Store) existingRecoveryMemorySchema() int {
	if s.row("SELECT name FROM sqlite_master WHERE type='table' AND name='projectMemoryMetaV2'") != nil {
		if !s.memoryColumnsPresent("projectMemoryMetaV2", "id", "schemaVersion") {
			return -1
		}
		if integer(s.row("SELECT schemaVersion FROM projectMemoryMetaV2 WHERE id=1")["schemaVersion"]) != 2 {
			return -1
		}
		return 2
	}
	if s.memoryColumnsPresent("projectMemories", "projectId", "key", "revision", "deletedAt") {
		return 1
	}
	return 0
}
