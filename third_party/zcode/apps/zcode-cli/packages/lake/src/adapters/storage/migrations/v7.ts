// Preserves the Lake Apache-2.0 schema migration.
export const sql = `ALTER TABLE conversation_turn ADD COLUMN specialists TEXT NOT NULL DEFAULT '[]';`;
