// Preserves the Lake Apache-2.0 schema migration.
export const sql = `
CREATE TABLE IF NOT EXISTS workflow_organization (
  kind TEXT NOT NULL CHECK(kind IN ('folder','v1','v2')),
  id TEXT NOT NULL,
  lake_id TEXT NOT NULL REFERENCES lake(id) ON DELETE CASCADE,
  parent_id TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL CHECK(position >= 0),
  name TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(kind,id)
);
CREATE INDEX IF NOT EXISTS workflow_organization_parent ON workflow_organization(lake_id,parent_id,position);
`;
