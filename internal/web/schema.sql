
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, createdAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS resources (
        id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id),
        name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('local','ssh','database','docker','redis')),
        description TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('available','unavailable'))
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL, status TEXT NOT NULL
          CHECK(status IN ('idle','investigating','waiting_approval','completed','failed')),
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS resourceTree (
        id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id),
        parentId TEXT REFERENCES resourceTree(id),
        kind TEXT NOT NULL CHECK(kind IN ('folder','resource')),
        name TEXT NOT NULL DEFAULT '', resourceId TEXT UNIQUE REFERENCES resources(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        CHECK((kind='folder' AND resourceId IS NULL) OR (kind='resource' AND resourceId IS NOT NULL))
      );
      CREATE INDEX IF NOT EXISTS resourceTree_children ON resourceTree(projectId,parentId,position);
      CREATE TABLE IF NOT EXISTS sessionNaming (
        sessionId TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        generated INTEGER NOT NULL DEFAULT 0 CHECK(generated IN (0,1))
      );
      CREATE TABLE IF NOT EXISTS sessionResources (
        sessionId TEXT NOT NULL REFERENCES sessions(id),
        resourceId TEXT NOT NULL REFERENCES resources(id),
        PRIMARY KEY (sessionId, resourceId)
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, sessionId TEXT NOT NULL REFERENCES sessions(id),
        role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
        text TEXT NOT NULL, images TEXT NOT NULL DEFAULT '[]', mentions TEXT, createdAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS specialists (
        id TEXT PRIMARY KEY, sessionId TEXT NOT NULL REFERENCES sessions(id),
        name TEXT NOT NULL, task TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('working','completed','failed')),
        summary TEXT, createdAt TEXT NOT NULL, finishedAt TEXT
      );
      CREATE TABLE IF NOT EXISTS evidence (
        id TEXT PRIMARY KEY, sessionId TEXT NOT NULL REFERENCES sessions(id),
        specialistId TEXT REFERENCES specialists(id),
        resourceId TEXT NOT NULL REFERENCES resources(id),
        title TEXT NOT NULL, command TEXT, excerpt TEXT NOT NULL,
        exitCode INTEGER, collectedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS actions (
        id TEXT PRIMARY KEY, sessionId TEXT NOT NULL REFERENCES sessions(id),
        resourceId TEXT NOT NULL REFERENCES resources(id),
        command TEXT NOT NULL, reason TEXT NOT NULL, impact TEXT NOT NULL,
        verification TEXT NOT NULL, terminalId TEXT, contextVersion INTEGER, status TEXT NOT NULL
          CHECK(status IN ('pending','rejected','running','succeeded','failed','unknown')),
        exitCode INTEGER, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS terminals (
        id TEXT PRIMARY KEY, sessionId TEXT NOT NULL REFERENCES sessions(id),
        resourceId TEXT NOT NULL REFERENCES resources(id),
        status TEXT NOT NULL CHECK(status IN ('connecting','ready','busy','disconnected','unknown')),
        holder TEXT CHECK(holder IN ('user','agent') OR holder IS NULL),
        createdAt TEXT NOT NULL, contextVersion INTEGER NOT NULL DEFAULT 0, output TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS resourceConnections (
        resourceId TEXT PRIMARY KEY REFERENCES resources(id), config TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS terminalEntries (
        id TEXT PRIMARY KEY, terminalId TEXT NOT NULL REFERENCES terminals(id),
        actor TEXT NOT NULL CHECK(actor IN ('user','agent')),
        command TEXT NOT NULL, output TEXT NOT NULL,
        exitCode INTEGER, actionId TEXT REFERENCES actions(id), createdAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS aiOptions (sessionId TEXT PRIMARY KEY REFERENCES sessions(id), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        sessionId TEXT NOT NULL REFERENCES sessions(id),
        type TEXT NOT NULL CHECK(type IN ('session','message','specialist','evidence','action','terminal')),
        createdAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(projectId);
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(sessionId, createdAt);
      CREATE INDEX IF NOT EXISTS idx_specialists_session ON specialists(sessionId, createdAt);
      CREATE INDEX IF NOT EXISTS idx_evidence_session ON evidence(sessionId, collectedAt);
      CREATE INDEX IF NOT EXISTS idx_actions_session ON actions(sessionId, createdAt);
      CREATE INDEX IF NOT EXISTS idx_terminals_session ON terminals(sessionId, createdAt);
      CREATE INDEX IF NOT EXISTS idx_entries_terminal ON terminalEntries(terminalId, createdAt);
      CREATE INDEX IF NOT EXISTS idx_events_session ON events(sessionId, seq);
      CREATE TABLE IF NOT EXISTS messageQueueState (
        sessionId TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        paused INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0,
        lastError TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS queuedMessages (
        id TEXT PRIMARY KEY, sessionId TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        position INTEGER NOT NULL, payload TEXT NOT NULL, createdAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS queued_messages_session ON queuedMessages(sessionId,position);
      CREATE TABLE IF NOT EXISTS replyTimings (
        messageId TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
        sessionId TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        startedAt TEXT NOT NULL, finishedAt TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'running'
      );
      CREATE INDEX IF NOT EXISTS reply_timings_session ON replyTimings(sessionId,startedAt);

CREATE TABLE IF NOT EXISTS workflows (
 id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id),
 name TEXT NOT NULL, goal TEXT NOT NULL, steps TEXT NOT NULL,
 version INTEGER NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS workflows_project ON workflows(projectId,updatedAt);
CREATE TABLE IF NOT EXISTS workflowRuns (
 id TEXT PRIMARY KEY, workflowId TEXT REFERENCES workflows(id) ON DELETE SET NULL,
 projectId TEXT NOT NULL REFERENCES projects(id), sessionId TEXT UNIQUE NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 template TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('running','completed','failed','cancelled','interrupted')),
 error TEXT NOT NULL DEFAULT '', createdAt TEXT NOT NULL, finishedAt TEXT
);
CREATE INDEX IF NOT EXISTS workflow_runs_project ON workflowRuns(projectId,createdAt);
      CREATE TABLE IF NOT EXISTS navigationTrash (
        kind TEXT NOT NULL CHECK(kind IN ('project','resource','folder')),
        id TEXT NOT NULL, projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', deletedAt TEXT NOT NULL,
        PRIMARY KEY(kind,id)
      );

      CREATE TABLE IF NOT EXISTS sreProjectSettings(projectId TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)));
      CREATE TABLE IF NOT EXISTS sreTasks(id TEXT PRIMARY KEY,sessionId TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,requestId TEXT NOT NULL,status TEXT NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL,UNIQUE(sessionId,requestId));
      CREATE INDEX IF NOT EXISTS sreTasks_session ON sreTasks(sessionId,createdAt,id);
      CREATE UNIQUE INDEX IF NOT EXISTS sreTasks_one_active ON sreTasks(sessionId) WHERE status IN ('draft','active','waiting_input','waiting_approval','paused');
      CREATE TABLE IF NOT EXISTS srePlanRevisions(id TEXT PRIMARY KEY,taskId TEXT NOT NULL REFERENCES sreTasks(id) ON DELETE CASCADE,version INTEGER NOT NULL,body TEXT NOT NULL,UNIQUE(taskId,version));
      CREATE TABLE IF NOT EXISTS srePlanRuns(id TEXT PRIMARY KEY,taskId TEXT NOT NULL REFERENCES sreTasks(id) ON DELETE CASCADE,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sreStepAttempts(id TEXT PRIMARY KEY,taskId TEXT NOT NULL REFERENCES sreTasks(id) ON DELETE CASCADE,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sreMessages(id TEXT PRIMARY KEY,taskId TEXT NOT NULL REFERENCES sreTasks(id) ON DELETE CASCADE,sequence INTEGER NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sreEvents(id INTEGER PRIMARY KEY AUTOINCREMENT,taskId TEXT NOT NULL REFERENCES sreTasks(id) ON DELETE CASCADE,sessionId TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,type TEXT NOT NULL,payload TEXT NOT NULL,createdAt TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS sreEvents_task ON sreEvents(taskId,id);
      CREATE TABLE IF NOT EXISTS sreVerificationResults(id TEXT PRIMARY KEY,taskId TEXT NOT NULL REFERENCES sreTasks(id) ON DELETE CASCADE,body TEXT NOT NULL);
