// Preserves the Lake Apache-2.0 schema migration.
export const sql = `
CREATE TABLE memory_policy (
  lake_id TEXT PRIMARY KEY REFERENCES lake(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  updated_at INTEGER NOT NULL
);
CREATE TABLE memory_fact (
  id TEXT PRIMARY KEY,
  lake_id TEXT NOT NULL REFERENCES lake(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES code_project(id) ON DELETE CASCADE,
  source_conversation_id TEXT NOT NULL,
  source_event_seq INTEGER NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  FOREIGN KEY(source_conversation_id,source_event_seq) REFERENCES conversation_event(conversation_id,seq) ON DELETE CASCADE
);
CREATE INDEX memory_fact_scope_idx ON memory_fact(lake_id,project_id,deleted_at,created_at);
`;
