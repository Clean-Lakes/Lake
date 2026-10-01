// Preserves the Lake Apache-2.0 schema migration.
export const sql = `
CREATE TABLE schedule (
  id TEXT PRIMARY KEY,
  lake_id TEXT NOT NULL REFERENCES lake(id) ON DELETE CASCADE,
  workflow_id TEXT NOT NULL REFERENCES workflow_v2_definition(id) ON DELETE CASCADE,
  workflow_revision INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('once','cron')),
  expression TEXT NOT NULL,
  timezone TEXT NOT NULL,
  next_at INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  fail_count INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT NOT NULL DEFAULT '',
  lease_until INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX schedule_due_idx ON schedule(enabled,next_at,lease_until);
CREATE TABLE schedule_run (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES schedule(id) ON DELETE CASCADE,
  workflow_run_id TEXT REFERENCES workflow_v2_run(id) ON DELETE SET NULL,
  due_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('claimed','running','waiting_approval','completed','failed','missed','unknown')),
  lease_owner TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(schedule_id,due_at)
);
CREATE INDEX schedule_run_schedule_idx ON schedule_run(schedule_id,created_at DESC);
CREATE TABLE schedule_grant (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES schedule(id) ON DELETE CASCADE,
  workflow_revision INTEGER NOT NULL,
  node_id TEXT NOT NULL,
  resource_id TEXT NOT NULL REFERENCES resource(id) ON DELETE CASCADE,
  command_sha256 TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  max_runs INTEGER NOT NULL CHECK(max_runs BETWEEN 1 AND 10000),
  used_runs INTEGER NOT NULL DEFAULT 0 CHECK(used_runs >= 0),
  created_at INTEGER NOT NULL,
  UNIQUE(schedule_id,workflow_revision,node_id,resource_id,command_sha256)
);
CREATE INDEX schedule_grant_lookup_idx ON schedule_grant(schedule_id,workflow_revision,node_id);
`;
