// Preserves the Lake Apache-2.0 schema migration.
export const sql = `
CREATE TABLE extension_config (
  kind TEXT NOT NULL CHECK(kind IN ('plugin','hook')),
  name TEXT NOT NULL,
  workspace_path TEXT NOT NULL DEFAULT '',
  version TEXT NOT NULL,
  source TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  install_path TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  declaration_sha256 TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(kind,name,workspace_path)
);
CREATE INDEX extension_config_kind_enabled_idx ON extension_config(kind,enabled,name);
`;
