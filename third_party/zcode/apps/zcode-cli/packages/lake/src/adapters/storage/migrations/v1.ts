// Preserves the Lake Apache-2.0 schema migration.
export const sql = `
CREATE TABLE lake (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE current_lake (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  lake_id TEXT REFERENCES lake(id) ON DELETE SET NULL
);
INSERT INTO current_lake(singleton, lake_id) VALUES (1, NULL);
CREATE TABLE resource (
  id TEXT PRIMARY KEY,
  lake_id TEXT NOT NULL REFERENCES lake(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind = 'host'),
  name TEXT NOT NULL,
  spec TEXT NOT NULL,
  execute_authz INTEGER NOT NULL DEFAULT 0 CHECK (execute_authz IN (0, 1)),
  env TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (lake_id, name)
);
CREATE INDEX resource_lake_idx ON resource(lake_id, name);
CREATE TABLE attach (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL REFERENCES resource(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('credential', 'script', 'note')),
  ref TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX resource_credential_idx ON attach(resource_id) WHERE kind = 'credential';
CREATE INDEX attach_resource_idx ON attach(resource_id, kind);
CREATE TABLE link (
  from_id TEXT NOT NULL REFERENCES resource(id) ON DELETE CASCADE,
  to_id TEXT NOT NULL REFERENCES resource(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('depends_on', 'part_of', 'connects_to')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (from_id, to_id, type),
  CHECK (from_id <> to_id)
);
CREATE INDEX link_to_idx ON link(to_id);
CREATE TABLE script (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  language TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  lake_id TEXT REFERENCES lake(id) ON DELETE CASCADE,
  resource_id TEXT REFERENCES resource(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((lake_id IS NULL) <> (resource_id IS NULL))
);
CREATE UNIQUE INDEX lake_script_name_idx ON script(lake_id, name) WHERE lake_id IS NOT NULL;
CREATE UNIQUE INDEX resource_script_name_idx ON script(resource_id, name) WHERE resource_id IS NOT NULL;
CREATE TABLE patrol (
  run_id TEXT PRIMARY KEY,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'unknown')),
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE TABLE journal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  run_id TEXT,
  action_id TEXT NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('cli', 'agent')),
  target_path TEXT NOT NULL,
  tool TEXT NOT NULL,
  risk TEXT NOT NULL CHECK (risk IN ('none', 'read', 'write', 'block')),
  event TEXT NOT NULL CHECK (event IN ('requested', 'proposed', 'approved', 'started', 'completed', 'denied', 'failed', 'unknown')),
  detail TEXT NOT NULL DEFAULT '',
  exit_code INTEGER,
  duration_ms INTEGER
);
CREATE INDEX journal_action_idx ON journal(action_id, id);
CREATE INDEX journal_run_idx ON journal(run_id, id);
CREATE INDEX journal_target_idx ON journal(target_path, id);
CREATE TRIGGER journal_no_update BEFORE UPDATE ON journal BEGIN SELECT RAISE(ABORT, 'journal is append-only'); END;
CREATE TRIGGER journal_no_delete BEFORE DELETE ON journal BEGIN SELECT RAISE(ABORT, 'journal is append-only'); END;
`;
