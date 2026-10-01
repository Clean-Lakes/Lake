// Preserves the Lake Apache-2.0 schema migration.
export const sql = `
CREATE TABLE conversation_event (
  conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK(seq > 0),
  kind TEXT NOT NULL,
  actor TEXT NOT NULL,
  tool_call_id TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL,
  legacy_turn_id TEXT REFERENCES conversation_turn(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(conversation_id,seq),
  UNIQUE(legacy_turn_id,kind)
);
CREATE TABLE conversation_summary (
  conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  through_seq INTEGER NOT NULL CHECK(through_seq > 0),
  text TEXT NOT NULL,
  source_event_ids TEXT NOT NULL,
  token_estimate INTEGER NOT NULL CHECK(token_estimate >= 0),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(conversation_id,through_seq)
);
`;
