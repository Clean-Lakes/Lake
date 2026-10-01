// Preserves the Lake Apache-2.0 schema migration.
export const sql = `
CREATE TABLE resource_new (
  id TEXT PRIMARY KEY,
  lake_id TEXT NOT NULL REFERENCES lake(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('host', 'k8s')),
  name TEXT NOT NULL,
  spec TEXT NOT NULL,
  execute_authz INTEGER NOT NULL DEFAULT 0 CHECK (execute_authz IN (0, 1)),
  env TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (lake_id, name)
);
INSERT INTO resource_new SELECT * FROM resource;
DROP TABLE resource;
ALTER TABLE resource_new RENAME TO resource;
CREATE INDEX resource_lake_idx ON resource(lake_id, name);
`;
