/*
 * Copyright 2026 CloudWeGo Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

package store

const migrationV1 = `
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
`

const migrationV2 = `
CREATE TABLE permission_policy (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  silent_ssh_read INTEGER NOT NULL DEFAULT 1 CHECK (silent_ssh_read IN (0, 1)),
  silent_ssh_command INTEGER NOT NULL DEFAULT 0 CHECK (silent_ssh_command IN (0, 1))
);
INSERT INTO permission_policy(singleton, silent_ssh_read, silent_ssh_command) VALUES (1, 1, 0);
`

const migrationV3 = `
CREATE TABLE conversation (
  id TEXT PRIMARY KEY,
  lake_id TEXT NOT NULL REFERENCES lake(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '新会话',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER
);
CREATE INDEX conversation_lake_updated_idx ON conversation(lake_id, archived_at, updated_at DESC);
CREATE TABLE conversation_turn (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL,
  answer TEXT NOT NULL DEFAULT '',
  display TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX conversation_turn_order_idx ON conversation_turn(conversation_id, created_at, id);
`

const migrationV4 = `
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
`

const migrationV5 = `
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
`

const migrationV6 = `ALTER TABLE conversation_turn ADD COLUMN images TEXT NOT NULL DEFAULT '[]';`

const migrationV7 = `ALTER TABLE conversation_turn ADD COLUMN specialists TEXT NOT NULL DEFAULT '[]';`

const migrationV8 = `
CREATE TABLE conversation_event (
  conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK(seq > 0),
  kind TEXT NOT NULL,
  actor TEXT NOT NULL,
  tool_call_id TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL,
  legacy_turn_id TEXT REFERENCES conversation_turn(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(conversation_id,seq),
  UNIQUE(legacy_turn_id,kind)
);
CREATE TABLE conversation_summary (
  conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  through_seq INTEGER NOT NULL CHECK(through_seq > 0),
  text TEXT NOT NULL,
  source_event_ids TEXT NOT NULL,
  token_estimate INTEGER NOT NULL CHECK(token_estimate >= 0),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(conversation_id,through_seq)
);
`

const migrationV8Backfill = `
INSERT INTO conversation_event(conversation_id,seq,kind,actor,payload,legacy_turn_id,created_at)
WITH ordered AS (
  SELECT id,conversation_id,prompt,answer,created_at,
    row_number() OVER(PARTITION BY conversation_id ORDER BY created_at,rowid) AS turn_number
  FROM conversation_turn
)
SELECT conversation_id,turn_number*2-1,'user','user',json_object('text',prompt),id,created_at FROM ordered
UNION ALL
SELECT conversation_id,turn_number*2,'assistant','assistant',json_object('text',answer),id,created_at FROM ordered;
`

// SQLite cannot remove the v1 kind CHECK in place. v9 replaces the table
// while foreign keys are disabled on the migration connection only.
const migrationV9 = `
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
`

const migrationV10 = `
CREATE TABLE memory_policy (
  lake_id TEXT PRIMARY KEY REFERENCES lake(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  updated_at INTEGER NOT NULL
);
CREATE TABLE memory_fact (
  id TEXT PRIMARY KEY,
  lake_id TEXT NOT NULL REFERENCES lake(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES code_project(id) ON DELETE CASCADE,
  source_conversation_id TEXT NOT NULL,
  source_event_seq INTEGER NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  FOREIGN KEY(source_conversation_id,source_event_seq) REFERENCES conversation_event(conversation_id,seq) ON DELETE CASCADE
);
CREATE INDEX memory_fact_scope_idx ON memory_fact(lake_id,project_id,deleted_at,created_at);
`

// Expand the resource kind constraint while retaining stable IDs and all
// attachments, links, and scripts that refer to existing resources.
const migrationV11 = `
CREATE TABLE resource_new (
  id TEXT PRIMARY KEY,
  lake_id TEXT NOT NULL REFERENCES lake(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('host', 'k8s', 'mysql', 'postgres', 'starrocks')),
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
`

const migrationV12 = `
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
`

const migrationV13 = `
CREATE TABLE specialist_task (
  id TEXT PRIMARY KEY,
  conversation_id TEXT REFERENCES conversation(id) ON DELETE SET NULL,
  parent_run_id TEXT NOT NULL,
  parent_task_id TEXT REFERENCES specialist_task(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  model TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  response_sha256 TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('delegated','running','completed','failed','unknown')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX specialist_task_run_idx ON specialist_task(parent_run_id,created_at,id);
CREATE INDEX specialist_task_conversation_idx ON specialist_task(conversation_id,created_at,id);
`

const migrationV14 = `
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
`

const migrationV15 = `
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
`

const migrationV16 = `
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
`
