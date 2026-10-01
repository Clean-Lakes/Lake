// Preserves the Lake Apache-2.0 schema migration.
export const sql = `
CREATE TABLE specialist_task (
  id TEXT PRIMARY KEY,
  conversation_id TEXT REFERENCES conversation(id) ON DELETE SET NULL,
  parent_run_id TEXT NOT NULL,
  parent_task_id TEXT REFERENCES specialist_task(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  model TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  response_sha256 TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('delegated','running','completed','failed','unknown')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX specialist_task_run_idx ON specialist_task(parent_run_id,created_at,id);
CREATE INDEX specialist_task_conversation_idx ON specialist_task(conversation_id,created_at,id);
`;
