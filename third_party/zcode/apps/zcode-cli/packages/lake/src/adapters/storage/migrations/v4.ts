// Preserves the Lake Apache-2.0 schema migration.
export const sql = `
CREATE TABLE code_project (
  id TEXT PRIMARY KEY,
  lake_id TEXT NOT NULL REFERENCES lake(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(lake_id, name),
  UNIQUE(lake_id, path)
);
CREATE INDEX code_project_lake_idx ON code_project(lake_id, name);
ALTER TABLE conversation ADD COLUMN project_id TEXT REFERENCES code_project(id) ON DELETE SET NULL;
`;
