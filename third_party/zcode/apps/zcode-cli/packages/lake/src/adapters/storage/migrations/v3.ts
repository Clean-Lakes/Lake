// Preserves the Lake Apache-2.0 schema migration.
export const sql = `
CREATE TABLE conversation (
  id TEXT PRIMARY KEY,
  lake_id TEXT NOT NULL REFERENCES lake(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '新会话',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER
);
CREATE INDEX conversation_lake_updated_idx ON conversation(lake_id, archived_at, updated_at DESC);
CREATE TABLE conversation_turn (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL,
  answer TEXT NOT NULL DEFAULT '',
  display TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX conversation_turn_order_idx ON conversation_turn(conversation_id, created_at, id);
`;
