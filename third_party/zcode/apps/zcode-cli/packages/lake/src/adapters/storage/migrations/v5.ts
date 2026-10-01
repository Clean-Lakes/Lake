// Preserves the Lake Apache-2.0 schema migration.
export const sql = `
CREATE TABLE ops_workflow (
  id TEXT PRIMARY KEY,
  lake_id TEXT NOT NULL REFERENCES lake(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  spec TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(lake_id,name)
);
CREATE INDEX ops_workflow_lake_idx ON ops_workflow(lake_id,name);
CREATE TABLE ops_workflow_run (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES ops_workflow(id) ON DELETE CASCADE,
  lake_id TEXT NOT NULL REFERENCES lake(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  spec TEXT NOT NULL,
  trigger_kind TEXT NOT NULL CHECK(trigger_kind IN ('agent','cli','desktop','schedule')),
  status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed','cancelled','interrupted')),
  error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX ops_workflow_run_order_idx ON ops_workflow_run(lake_id,created_at DESC);
CREATE TABLE ops_workflow_step_run (
  run_id TEXT NOT NULL REFERENCES ops_workflow_run(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed','skipped','unknown','cancelled')),
  stdout TEXT NOT NULL DEFAULT '',
  stderr TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  exit_code INTEGER,
  started_at INTEGER,
  finished_at INTEGER,
  PRIMARY KEY(run_id,step_id)
);
CREATE TABLE ops_workflow_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES ops_workflow_run(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  ts INTEGER NOT NULL
);
CREATE INDEX ops_workflow_event_run_idx ON ops_workflow_event(run_id,id);
`;
