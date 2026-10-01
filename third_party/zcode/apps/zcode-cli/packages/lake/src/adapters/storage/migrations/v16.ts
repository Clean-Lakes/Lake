// Preserves the Lake Apache-2.0 schema migration.
export const sql = `
CREATE TABLE code_workspace (
  id TEXT PRIMARY KEY,
  lake_id TEXT NOT NULL REFERENCES lake(id) ON DELETE CASCADE,
  resource_id TEXT NOT NULL REFERENCES resource(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  remote_root TEXT NOT NULL,
  authorized INTEGER NOT NULL DEFAULT 0 CHECK(authorized IN (0,1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(lake_id,name),
  UNIQUE(resource_id,remote_root)
);
CREATE INDEX code_workspace_lake_idx ON code_workspace(lake_id,name);
ALTER TABLE conversation ADD COLUMN remote_workspace_id TEXT REFERENCES code_workspace(id) ON DELETE SET NULL;
`;
