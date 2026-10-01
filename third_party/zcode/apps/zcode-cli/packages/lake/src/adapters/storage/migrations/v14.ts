// Preserves the Lake Apache-2.0 schema migration.
export const sql = `
CREATE TABLE workflow_v2_definition (
  id TEXT PRIMARY KEY,
  lake_id TEXT NOT NULL REFERENCES lake(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  spec_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(lake_id,name)
);
CREATE TABLE workflow_v2_run (
  id TEXT PRIMARY KEY,
  definition_id TEXT REFERENCES workflow_v2_definition(id) ON DELETE SET NULL,
  lake_id TEXT NOT NULL REFERENCES lake(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  revision INTEGER NOT NULL,
  trigger TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','running','waiting_approval','completed','failed','interrupted')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX workflow_v2_run_lake_idx ON workflow_v2_run(lake_id,created_at);
CREATE TABLE workflow_v2_node (
  run_id TEXT NOT NULL REFERENCES workflow_v2_run(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','waiting_approval','running','completed','failed','skipped','cancelled','unknown')),
  input_json TEXT NOT NULL DEFAULT '',
  approval_json TEXT NOT NULL DEFAULT '',
  result_json TEXT NOT NULL DEFAULT '',
  error_code TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(run_id,node_id)
);
CREATE TABLE workflow_v2_event (
  run_id TEXT NOT NULL REFERENCES workflow_v2_run(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  node_id TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  PRIMARY KEY(run_id,seq)
);
CREATE TRIGGER workflow_v2_event_no_update BEFORE UPDATE ON workflow_v2_event BEGIN SELECT RAISE(ABORT, 'workflow v2 event is append-only'); END;
CREATE TRIGGER workflow_v2_event_no_delete BEFORE DELETE ON workflow_v2_event BEGIN SELECT RAISE(ABORT, 'workflow v2 event is append-only'); END;
`;
