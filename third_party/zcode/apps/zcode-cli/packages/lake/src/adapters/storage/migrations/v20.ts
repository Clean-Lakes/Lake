/** LAKE associations only. Native workflow source and runs remain in native storage. */
export const sql = `
CREATE TABLE IF NOT EXISTS lake_native_workspace (
  name TEXT NOT NULL,
  workspace_path TEXT NOT NULL,
  lake_id TEXT NOT NULL REFERENCES lake(id),
  manifest_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(name,workspace_path)
);
CREATE TABLE IF NOT EXISTS lake_native_workflow (
  name TEXT NOT NULL,
  workspace_path TEXT NOT NULL,
  lake_id TEXT NOT NULL REFERENCES lake(id),
  manifest_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(name,workspace_path)
);
`;
