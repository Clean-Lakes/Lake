import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, chmodSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sshConfig } from "./ssh.js";
import { commandPolicy, dangerConfirmation } from "../../shared/command-policy.js";
import type {
  AIImage, Action, Catalog, Evidence, Message, Project, Resource, SessionEvent,
  SessionSnapshot, Specialist, TerminalEntry, TerminalHistory, TerminalSession,
  WorkSession,
} from "../../shared/contracts.js";

export class ApiFailure extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const now = () => new Date().toISOString();
const id = () => randomUUID();
const stringRows = <T>(rows: unknown[]): T[] => rows as T[];
const required = <T>(row: T | undefined, name: string): T => {
  if (!row) throw new ApiFailure(404, `${name} not found`);
  return row;
};

export function dataDirectory(): string {
  return process.env.LAKE_WEB_DATA_DIR || join(homedir(), ".lake", "web-agent");
}

export class Store {
  readonly db: DatabaseSync;
  private readonly updates = new EventEmitter();
  private pendingEvents: SessionEvent[] | null = null;

  constructor(dir = dataDirectory()) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const path = join(dir, "lake-web.sqlite");
    this.db = new DatabaseSync(path);
    if (existsSync(path)) chmodSync(path, 0o600);
    this.db.exec(`
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
      CREATE TABLE IF NOT EXISTS sessionResources (
        sessionId TEXT NOT NULL REFERENCES sessions(id),
        resourceId TEXT NOT NULL REFERENCES resources(id),
        PRIMARY KEY (sessionId, resourceId)
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, sessionId TEXT NOT NULL REFERENCES sessions(id),
        role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
        text TEXT NOT NULL, images TEXT NOT NULL DEFAULT '[]', createdAt TEXT NOT NULL
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
    `);
    // Upgrade the original prototype without losing its session history.
    const columns = (table: string) => (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name);
    for (const [table, column, definition] of [
      ["messages", "images", "TEXT NOT NULL DEFAULT '[]'"],
      ["actions", "terminalId", "TEXT"], ["actions", "contextVersion", "INTEGER"],
      ["terminals", "contextVersion", "INTEGER NOT NULL DEFAULT 0"], ["terminals", "output", "TEXT NOT NULL DEFAULT ''"],
    ]) if (!columns(table!).includes(column!)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    for (const table of ["resources", "terminals"]) {
      const schema = (this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as { sql: string }).sql;
      const upgraded = table === "resources"
        ? schema.replace("CHECK(kind = 'local')", "CHECK(kind IN ('local','ssh','database','docker','redis'))").replace("CHECK(kind IN ('local','ssh'))", "CHECK(kind IN ('local','ssh','database','docker','redis'))")
        : schema.replace("CHECK(status IN ('ready','busy','disconnected','unknown'))", "CHECK(status IN ('connecting','ready','busy','disconnected','unknown'))");
      if (upgraded === schema) continue;
      this.db.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
      try {
        this.db.exec(upgraded.replace(new RegExp(`^CREATE TABLE "?${table}"?`), `CREATE TABLE ${table}_next`));
        this.db.exec(`INSERT INTO ${table}_next SELECT * FROM ${table}; DROP TABLE ${table}; ALTER TABLE ${table}_next RENAME TO ${table}; COMMIT`);
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
      finally { this.db.exec("PRAGMA foreign_keys=ON"); }
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_terminals_session ON terminals(sessionId, createdAt)");
    // Processes and in-flight actions cannot survive a server restart. Never replay them.
    this.transaction(() => {
      const live = stringRows<{ id: string; sessionId: string }>(
        this.db.prepare("SELECT id, sessionId FROM terminals WHERE status IN ('connecting','ready','busy','unknown')").all(),
      );
      this.db.prepare("UPDATE terminals SET status = 'disconnected', holder = NULL WHERE status != 'disconnected'").run();
      for (const terminal of live) this.event(terminal.sessionId, "terminal");
      const running = stringRows<{ id: string; sessionId: string }>(
        this.db.prepare("SELECT id, sessionId FROM actions WHERE status = 'running'").all(),
      );
      this.db.prepare("UPDATE actions SET status = 'unknown', updatedAt = ? WHERE status = 'running'").run(now());
      for (const action of running) this.event(action.sessionId, "action");
      const workers = stringRows<{ id: string; sessionId: string }>(
        this.db.prepare("SELECT id, sessionId FROM specialists WHERE status = 'working'").all(),
      );
      this.db.prepare("UPDATE specialists SET status = 'failed', summary = 'Investigation interrupted by server restart', finishedAt = ? WHERE status = 'working'").run(now());
      for (const worker of workers) this.event(worker.sessionId, "specialist");
      const sessions = stringRows<{ id: string }>(
        this.db.prepare("SELECT id FROM sessions WHERE status = 'investigating' OR id IN (SELECT sessionId FROM actions WHERE status='unknown')").all(),
      );
      this.db.prepare("UPDATE sessions SET status = 'failed', updatedAt = ? WHERE status = 'investigating' OR id IN (SELECT sessionId FROM actions WHERE status='unknown')").run(now());
      for (const session of sessions) {
        this.event(session.id, "session");
        this.addMessage(session.id, "system", "服务重启导致本次工作被中断。正在执行的命令结果未知；请先核对实际状态，再决定是否重试。");
      }
    });
  }

  close(): void { this.db.close(); }
  touchAI(sessionId: string): void { this.session(sessionId); this.event(sessionId, "message"); }
  aiOptions(sessionId: string): Record<string, unknown> { this.session(sessionId); const row = this.db.prepare("SELECT value FROM aiOptions WHERE sessionId=?").get(sessionId) as { value: string } | undefined; return row ? JSON.parse(row.value) as Record<string, unknown> : {}; }
  saveAIOptions(sessionId: string, value: object): void { this.session(sessionId); this.db.prepare("INSERT INTO aiOptions(sessionId,value) VALUES(?,?) ON CONFLICT(sessionId) DO UPDATE SET value=excluded.value").run(sessionId, JSON.stringify(value)); this.touchAI(sessionId); }
  createServiceResource(projectId: string, name: string, kind: "database" | "docker" | "redis", value: unknown): Resource {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiFailure(400, "Connection settings required");
    const settings = value as Record<string, unknown>;
    const allowed = new Set(["driver", "host", "port", "username", "database", "path", "credentialRef", "tls", "sslmode", "db", "endpoint", "ssh_asset_ref"]);
    for (const key of Object.keys(settings)) if (!allowed.has(key)) throw new ApiFailure(400, "Unsupported connection field; credentials must use credentialRef");
    if (JSON.stringify(settings).length > 4000) throw new ApiFailure(400, "Connection settings too large");
    if (settings.credentialRef !== undefined && (typeof settings.credentialRef !== "string" || !settings.credentialRef)) throw new ApiFailure(400, "Invalid credential reference");
    if (typeof settings.endpoint === "string" && /@|[?]/.test(settings.endpoint)) throw new ApiFailure(400, "Endpoint must not contain credentials");
    if (kind === "redis" || kind === "database" && settings.driver !== "sqlite") {
      if (typeof settings.host !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9.:-]{0,252}$/.test(settings.host)) throw new ApiFailure(400, "Explicit connection host required");
      if (settings.port !== undefined && (!Number.isInteger(settings.port) || Number(settings.port) < 1 || Number(settings.port) > 65535)) throw new ApiFailure(400, "Connection port must be 1..65535");
    }
    if (kind === "database" && !["postgres", "mysql", "sqlite"].includes(String(settings.driver))) throw new ApiFailure(400, "Database driver must be postgres, mysql or sqlite");
    if (settings.ssh_asset_ref) { const linked = this.resource(String(settings.ssh_asset_ref)); if (linked.projectId !== projectId || linked.kind !== "ssh") throw new ApiFailure(400, "Associated SSH resource must belong to this project"); }
    return this.transaction(() => {
      required(this.db.prepare("SELECT id FROM projects WHERE id=?").get(projectId), "Project");
      const resource: Resource = { id: id(), projectId, name, kind, settings, description: String(settings.host || settings.path || settings.endpoint || kind), status: "available" };
      this.db.prepare("INSERT INTO resources(id,projectId,name,kind,description,status) VALUES(?,?,?,?,?,?)").run(resource.id, projectId, name, kind, resource.description, resource.status);
      this.db.prepare("INSERT INTO resourceConnections(resourceId,config) VALUES(?,?)").run(resource.id, JSON.stringify(settings));
      return resource;
    });
  }

  onEvent(listener: (event: SessionEvent) => void): () => void {
    this.updates.on("event", listener);
    return () => this.updates.off("event", listener);
  }

  private transaction<T>(work: () => T): T {
    if (this.pendingEvents) return work();
    this.db.exec("BEGIN IMMEDIATE");
    const events: SessionEvent[] = [];
    this.pendingEvents = events;
    try {
      const result = work();
      this.db.exec("COMMIT");
      this.pendingEvents = null;
      for (const event of events) this.updates.emit("event", event);
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      this.pendingEvents = null;
      throw error;
    }
  }

  private event(sessionId: string, type: SessionEvent["type"]): void {
    const createdAt = now();
    const info = this.db.prepare("INSERT INTO events(sessionId,type,createdAt) VALUES(?,?,?)")
      .run(sessionId, type, createdAt);
    const event: SessionEvent = { seq: Number(info.lastInsertRowid), sessionId, type, createdAt };
    if (this.pendingEvents) this.pendingEvents.push(event);
    else this.updates.emit("event", event);
  }

  catalog(): Catalog {
    return {
      projects: stringRows<Project>(this.db.prepare("SELECT * FROM projects ORDER BY createdAt, id").all()),
      resources: stringRows<Resource>(this.db.prepare("SELECT * FROM resources ORDER BY rowid").all()).map(row => this.resource(row.id)),
      sessions: stringRows<{ id: string }>(this.db.prepare("SELECT id FROM sessions ORDER BY createdAt DESC, rowid DESC").all())
        .map(({ id: sessionId }) => this.session(sessionId)),
    };
  }

  createProject(name: string): Project {
    return this.transaction(() => {
      const project: Project = { id: id(), name, createdAt: now() };
      this.db.prepare("INSERT INTO projects(id,name,createdAt) VALUES(?,?,?)")
        .run(project.id, project.name, project.createdAt);
      const resource: Resource = {
        id: id(), projectId: project.id, name: "Local machine", kind: "local",
        description: "This server's local command terminal (no remote host connection)", status: "available",
      };
      this.db.prepare("INSERT INTO resources(id,projectId,name,kind,description,status) VALUES(?,?,?,?,?,?)")
        .run(resource.id, resource.projectId, resource.name, resource.kind, resource.description, resource.status);
      return project;
    });
  }

  resource(resourceId: string): Resource {
    const resource = required(this.db.prepare("SELECT * FROM resources WHERE id=?").get(resourceId) as Resource | undefined, "Resource");
    const connection = this.db.prepare("SELECT config FROM resourceConnections WHERE resourceId=?").get(resourceId) as { config: string } | undefined;
    return { ...resource, ...(connection ? resource.kind === "ssh" ? { ssh: JSON.parse(connection.config) as NonNullable<Resource["ssh"]> } : { settings: JSON.parse(connection.config) as Record<string, unknown> } : {}) };
  }

  createSshResource(projectId: string, name: string, config: unknown): Resource {
    const ssh = sshConfig(config);
    return this.transaction(() => {
      required(this.db.prepare("SELECT id FROM projects WHERE id=?").get(projectId), "Project");
      const resource: Resource = { id: id(), projectId, name, kind: "ssh", ssh,
        description: `${ssh.username}@${ssh.host}:${ssh.port}`, status: "available" };
      this.db.prepare("INSERT INTO resources(id,projectId,name,kind,description,status) VALUES(?,?,?,?,?,?)")
        .run(resource.id, projectId, name, "ssh", resource.description, resource.status);
      this.db.prepare("INSERT INTO resourceConnections(resourceId,config) VALUES(?,?)").run(resource.id, JSON.stringify(ssh));
      return resource;
    });
  }

  session(sessionId: string): WorkSession {
    const session = required(this.db.prepare("SELECT * FROM sessions WHERE id=?").get(sessionId) as Omit<WorkSession,"resourceIds"> | undefined, "Session");
    const resourceIds = stringRows<{ resourceId: string }>(this.db.prepare("SELECT resourceId FROM sessionResources WHERE sessionId=? ORDER BY rowid").all(sessionId))
      .map((item) => item.resourceId);
    return { ...session, resourceIds };
  }

  createSession(projectId: string, title: string, resourceIds?: string[]): WorkSession {
    return this.transaction(() => {
      required(this.db.prepare("SELECT id FROM projects WHERE id=?").get(projectId), "Project");
      const available = stringRows<Resource>(this.db.prepare("SELECT * FROM resources WHERE projectId=? ORDER BY rowid").all(projectId));
      const chosen = resourceIds === undefined ? available.map((r) => r.id) : resourceIds;
      if (!chosen.length || new Set(chosen).size !== chosen.length || chosen.some((r) => !available.some((item) => item.id === r))) {
        throw new ApiFailure(400, "resourceIds must contain distinct resources in the project");
      }
      const session: WorkSession = {
        id: id(), projectId, title, status: "idle", resourceIds: chosen,
        createdAt: now(), updatedAt: now(),
      };
      this.db.prepare("INSERT INTO sessions(id,projectId,title,status,createdAt,updatedAt) VALUES(?,?,?,?,?,?)")
        .run(session.id, session.projectId, session.title, session.status, session.createdAt, session.updatedAt);
      const insert = this.db.prepare("INSERT INTO sessionResources(sessionId,resourceId) VALUES(?,?)");
      for (const resourceId of chosen) insert.run(session.id, resourceId);
      this.event(session.id, "session");
      return session;
    });
  }

  assertSessionResource(sessionId: string, resourceId: string): void {
    this.session(sessionId);
    if (!this.db.prepare("SELECT 1 FROM sessionResources WHERE sessionId=? AND resourceId=?").get(sessionId, resourceId)) {
      throw new ApiFailure(404, "Resource not found in session");
    }
  }

  /**
   * Removes a session and everything recorded under it. Refuses while a command is
   * still running: the live shell belongs to this session and deleting it would
   * leave an untracked process behind.
   */
  deleteSession(sessionId: string): void {
    this.session(sessionId);
    const busy = this.db.prepare("SELECT 1 FROM terminals WHERE sessionId=? AND status IN ('connecting','busy')").get(sessionId)
      ?? this.db.prepare("SELECT 1 FROM actions WHERE sessionId=? AND status='running'").get(sessionId);
    if (this.session(sessionId).status === "investigating") throw new ApiFailure(409, "调查仍在进行。请等待完成后再删除会话。");
    if (busy) throw new ApiFailure(409, "该会话有命令正在执行。请先中断或等待它结束，再删除会话。");
    this.transaction(() => {
      // Child rows first: foreign keys are enforced, and outcomes reference both
      // the terminal and the action that produced them.
      this.db.prepare("DELETE FROM terminalEntries WHERE terminalId IN (SELECT id FROM terminals WHERE sessionId=?)").run(sessionId);
      this.db.prepare("DELETE FROM terminals WHERE sessionId=?").run(sessionId);
      this.db.prepare("DELETE FROM evidence WHERE sessionId=?").run(sessionId);
      this.db.prepare("DELETE FROM specialists WHERE sessionId=?").run(sessionId);
      this.db.prepare("DELETE FROM actions WHERE sessionId=?").run(sessionId);
      this.db.prepare("DELETE FROM messages WHERE sessionId=?").run(sessionId);
      this.db.prepare("DELETE FROM aiOptions WHERE sessionId=?").run(sessionId);
      this.db.prepare("DELETE FROM sessionResources WHERE sessionId=?").run(sessionId);
      this.db.prepare("DELETE FROM events WHERE sessionId=?").run(sessionId);
      this.db.prepare("DELETE FROM sessions WHERE id=?").run(sessionId);
    });
  }

  snapshot(sessionId: string): SessionSnapshot {
    const session = this.session(sessionId);
    const list = <T>(table: string, sort: string): T[] => stringRows<T>(
      this.db.prepare(`SELECT * FROM ${table} WHERE sessionId=? ORDER BY ${sort}, rowid`).all(sessionId),
    );
    const cursor = this.db.prepare("SELECT COALESCE(MAX(seq),0) AS cursor FROM events WHERE sessionId=?")
      .get(sessionId) as { cursor: number };
    return {
      session, resources: session.resourceIds.map((resourceId) => this.resource(resourceId)),
      messages: list<Message>("messages", "createdAt").map(row => {
        const { images: raw, ...message } = row;
        const images = JSON.parse(typeof raw === "string" ? raw : "[]") as AIImage[];
        return { ...message, ...(images.length ? { images: images.map(image => ({ ...image, base64: "", url: `/api/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(row.id)}/images/${encodeURIComponent(image.id)}` })) } : {}) };
      }),
      specialists: list<Specialist>("specialists", "createdAt"),
      evidence: list<Evidence>("evidence", "collectedAt"),
      actions: list<Action>("actions", "createdAt").map(action => this.action(action.id)),
      terminals: list<TerminalSession>("terminals", "createdAt").map(t => this.terminal(sessionId, t.id)),
      cursor: cursor.cursor,
    };
  }

  image(sessionId: string, messageId: string, imageId: string): AIImage {
    this.session(sessionId);
    const row = required(this.db.prepare("SELECT images FROM messages WHERE id=? AND sessionId=?").get(messageId, sessionId) as { images: string } | undefined, "Message");
    return required((JSON.parse(row.images) as AIImage[]).find(image => image.id === imageId), "Image");
  }
  events(sessionId: string, after: number): SessionEvent[] {
    this.session(sessionId);
    return stringRows<SessionEvent>(this.db.prepare("SELECT * FROM events WHERE sessionId=? AND seq>? ORDER BY seq LIMIT 1000").all(sessionId, after));
  }

  addMessage(sessionId: string, role: Message["role"], text: string, images: AIImage[] = []): Message {
    return this.transaction(() => {
      this.session(sessionId);
      const message: Message = { id: id(), sessionId, role, text, ...(images.length ? { images } : {}), createdAt: now() };
      this.db.prepare("INSERT INTO messages(id,sessionId,role,text,images,createdAt) VALUES(?,?,?,?,?,?)")
        .run(message.id, message.sessionId, message.role, message.text, JSON.stringify(images), message.createdAt);
      this.event(sessionId, "message");
      return message;
    });
  }

  beginInvestigation(sessionId: string, text: string, images: AIImage[] = []): Message {
    return this.transaction(() => {
      const session = this.session(sessionId);
      if (session.status === "investigating") throw new ApiFailure(409, "Investigation already running");
      const message = this.addMessage(sessionId, "user", text, images);
      this.setSessionStatus(sessionId, "investigating");
      return message;
    });
  }

  setSessionStatus(sessionId: string, status: WorkSession["status"]): void {
    this.transaction(() => {
      this.db.prepare("UPDATE sessions SET status=?,updatedAt=? WHERE id=?").run(status, now(), sessionId);
      this.event(sessionId, "session");
    });
  }

  addSpecialist(sessionId: string, name: string, task: string): Specialist {
    return this.transaction(() => {
      const specialist: Specialist = {
        id: id(), sessionId, name, task, status: "working", summary: null,
        createdAt: now(), finishedAt: null,
      };
      this.db.prepare("INSERT INTO specialists(id,sessionId,name,task,status,summary,createdAt,finishedAt) VALUES(?,?,?,?,?,?,?,?)")
        .run(specialist.id, specialist.sessionId, specialist.name, specialist.task, specialist.status, specialist.summary, specialist.createdAt, specialist.finishedAt);
      this.event(sessionId, "specialist");
      return specialist;
    });
  }

  finishSpecialist(specialistId: string, status: "completed" | "failed", summary: string): void {
    this.transaction(() => {
      const specialist = required(this.db.prepare("SELECT * FROM specialists WHERE id=?").get(specialistId) as Specialist | undefined, "Specialist");
      this.db.prepare("UPDATE specialists SET status=?,summary=?,finishedAt=? WHERE id=? AND status='working'")
        .run(status, summary, now(), specialistId);
      this.event(specialist.sessionId, "specialist");
    });
  }

  addEvidence(specialistId: string, resourceId: string, title: string, entry: TerminalEntry): Evidence {
    return this.transaction(() => {
      const specialist = required(this.db.prepare("SELECT * FROM specialists WHERE id=?").get(specialistId) as Specialist | undefined, "Specialist");
      this.assertSessionResource(specialist.sessionId, resourceId);
      const evidence: Evidence = {
        id: id(), sessionId: specialist.sessionId, specialistId, resourceId, title,
        command: entry.command, excerpt: entry.output.slice(-2048), exitCode: entry.exitCode,
        collectedAt: entry.createdAt,
      };
      this.db.prepare("INSERT INTO evidence(id,sessionId,specialistId,resourceId,title,command,excerpt,exitCode,collectedAt) VALUES(?,?,?,?,?,?,?,?,?)")
        .run(evidence.id, evidence.sessionId, evidence.specialistId, evidence.resourceId, evidence.title,
          evidence.command, evidence.excerpt, evidence.exitCode, evidence.collectedAt);
      this.event(specialist.sessionId, "evidence");
      return evidence;
    });
  }

  addAction(sessionId: string, resourceId: string, command: string, reason: string, impact: string, verification: string, terminalId: string | null = null): Action {
    return this.transaction(() => {
      this.assertSessionResource(sessionId, resourceId);
      if (terminalId && this.terminal(sessionId, terminalId).resourceId !== resourceId) throw new ApiFailure(400, "Action target does not match terminal");
      const time = now();
      const action: Action = {
        id: id(), sessionId, resourceId, command, reason, impact, verification, terminalId,
        risk: commandPolicy(command).risk, riskReason: commandPolicy(command).riskReason,
        contextVersion: terminalId ? this.terminal(sessionId, terminalId).contextVersion : null,
        status: "pending", exitCode: null, createdAt: time, updatedAt: time,
      };
      this.db.prepare("INSERT INTO actions(id,sessionId,resourceId,command,reason,impact,verification,terminalId,contextVersion,status,exitCode,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(action.id, action.sessionId, action.resourceId, action.command, action.reason, action.impact,
          action.verification, action.terminalId, action.contextVersion, action.status, action.exitCode, action.createdAt, action.updatedAt);
      this.event(sessionId, "action");
      return action;
    });
  }

  action(actionId: string): Action {
    const action = required(this.db.prepare("SELECT * FROM actions WHERE id=?").get(actionId) as Action | undefined, "Action");
    const { risk, riskReason } = commandPolicy(action.command);
    return { ...action, risk, riskReason };
  }

  decideAction(actionId: string, decision: "approve" | "reject", confirmation?: unknown): Action {
    return this.transaction(() => {
      const action = this.action(actionId);
      if (action.status !== "pending") throw new ApiFailure(409, "Action already decided");
      if (this.session(action.sessionId).status === "investigating") throw new ApiFailure(409, "Wait for the current reply or investigation before deciding this action");
      if (decision === "approve" && action.risk === "dangerous" && confirmation !== dangerConfirmation(this.resource(action.resourceId).name)) {
        throw new ApiFailure(400, "Dangerous command requires explicit target confirmation");
      }
      this.db.prepare("UPDATE actions SET status=?,updatedAt=? WHERE id=? AND status='pending'")
        .run(decision === "reject" ? "rejected" : "running", now(), actionId);
      this.event(action.sessionId, "action");
      if (decision === "reject") this.setSessionStatus(action.sessionId, "completed");
      else this.setSessionStatus(action.sessionId, "investigating");
      return this.action(actionId);
    });
  }

  completeAction(actionId: string, status: "succeeded" | "failed" | "unknown", exitCode: number | null): void {
    this.transaction(() => {
      const action = this.action(actionId);
      if (action.status !== "running") return;
      this.db.prepare("UPDATE actions SET status=?,exitCode=?,updatedAt=? WHERE id=?")
        .run(status, exitCode, now(), actionId);
      this.event(action.sessionId, "action");
      this.addMessage(action.sessionId, "system", status === "succeeded"
        ? `命令退出码为 0。这只说明命令执行成功，不能证明故障已恢复。请按此方式独立验证：${action.verification}`
        : status === "unknown"
          ? "命令执行结果未知。请先核对资源的实际状态，再考虑下一步操作。"
          : `命令退出码为 ${exitCode ?? "未知"}。请查看命令记录并独立验证：${action.verification}`);
      this.setSessionStatus(action.sessionId, status === "succeeded" ? "idle" : "failed");
    });
  }

  createTerminal(sessionId: string, resourceId: string): TerminalSession {
    return this.transaction(() => {
      this.assertSessionResource(sessionId, resourceId);
      const terminal: TerminalSession = {
        id: id(), sessionId, resourceId, status: "ready", holder: "user", contextVersion: 0, createdAt: now(),
      };
      this.db.prepare("INSERT INTO terminals(id,sessionId,resourceId,status,holder,createdAt) VALUES(?,?,?,?,?,?)")
        .run(terminal.id, terminal.sessionId, terminal.resourceId, terminal.status, terminal.holder, terminal.createdAt);
      this.event(sessionId, "terminal");
      return terminal;
    });
  }

  terminal(sessionId: string, terminalId: string): TerminalSession {
    return required(this.db.prepare("SELECT id,sessionId,resourceId,status,holder,createdAt,contextVersion FROM terminals WHERE id=? AND sessionId=?").get(terminalId, sessionId) as TerminalSession | undefined, "Terminal");
  }

  terminalForAction(action: Action): TerminalSession | undefined {
    if (action.terminalId) {
      const terminal = this.terminal(action.sessionId, action.terminalId);
      if (terminal.resourceId !== action.resourceId || terminal.contextVersion !== action.contextVersion) throw new ApiFailure(409, "终端上下文已变化，请重新提出操作后审批");
      return terminal.status === "ready" ? terminal : undefined;
    }
    return this.db.prepare("SELECT id,sessionId,resourceId,status,holder,createdAt,contextVersion FROM terminals WHERE sessionId=? AND resourceId=? AND status='ready' ORDER BY createdAt DESC LIMIT 1")
      .get(action.sessionId, action.resourceId) as TerminalSession | undefined;
  }

  history(sessionId: string, terminalId: string): TerminalHistory {
    const terminal = this.terminal(sessionId, terminalId);
    const entries = stringRows<TerminalEntry>(this.db.prepare(
      "SELECT id,terminalId,actor,command,output,exitCode,createdAt FROM terminalEntries WHERE terminalId=? ORDER BY rowid DESC LIMIT 500",
    ).all(terminalId)).reverse();
    const row = this.db.prepare("SELECT output FROM terminals WHERE id=?").get(terminalId) as { output: string };
    return { terminal, entries, output: row.output };
  }

  commandEntry(sessionId: string, terminalId: string, entryId: string): TerminalEntry {
    this.terminal(sessionId, terminalId);
    return required(this.db.prepare("SELECT id,terminalId,actor,command,output,exitCode,createdAt FROM terminalEntries WHERE id=? AND terminalId=?")
      .get(entryId, terminalId) as TerminalEntry | undefined, "Command");
  }

  recentHistory(sessionId: string): Array<{ entry: TerminalEntry; resourceId: string }> {
    this.session(sessionId);
    const rows = stringRows<TerminalEntry & { resourceId: string }>(this.db.prepare(`
      SELECT e.id,e.terminalId,e.actor,e.command,e.output,e.exitCode,e.createdAt,t.resourceId
      FROM terminalEntries e JOIN terminals t ON t.id=e.terminalId
      WHERE t.sessionId=? AND e.exitCode IS NOT NULL
      ORDER BY e.rowid DESC LIMIT 8
    `).all(sessionId));
    return rows.reverse().map(({ resourceId, ...entry }) => ({ entry, resourceId }));
  }

  controlTerminal(sessionId: string, terminalId: string, holder: TerminalSession["holder"]): TerminalSession {
    return this.transaction(() => {
      const terminal = this.terminal(sessionId, terminalId);
      if (terminal.status !== "ready" && !(holder === "user" && terminal.status === "busy")) throw new ApiFailure(409, "Terminal is not ready");
      this.db.prepare("UPDATE terminals SET holder=? WHERE id=?").run(holder, terminalId);
      this.event(sessionId, "terminal");
      return this.terminal(sessionId, terminalId);
    });
  }

  beginCommand(sessionId: string, terminalId: string, actor: TerminalEntry["actor"], command: string, actionId: string | null = null): TerminalEntry {
    return this.transaction(() => {
      const terminal = this.terminal(sessionId, terminalId);
      if (terminal.status !== "ready" || terminal.holder !== actor) {
        throw new ApiFailure(409, "Terminal busy or held by another actor");
      }
      const entry: TerminalEntry = { id: id(), terminalId, actor, command, output: "", exitCode: null, createdAt: now() };
      this.db.prepare("INSERT INTO terminalEntries(id,terminalId,actor,command,output,exitCode,actionId,createdAt) VALUES(?,?,?,?,?,?,?,?)")
        .run(entry.id, entry.terminalId, entry.actor, entry.command, entry.output, entry.exitCode, actionId, entry.createdAt);
      this.db.prepare("UPDATE terminals SET status='busy',contextVersion=contextVersion+1 WHERE id=?").run(terminalId);
      this.event(sessionId, "terminal");
      return entry;
    });
  }

  appendCommandOutput(sessionId: string, entryId: string, output: string): void {
    this.transaction(() => {
      this.db.prepare("UPDATE terminalEntries SET output=? WHERE id=?").run(output, entryId);
      this.event(sessionId, "terminal");
    });
  }

  finishCommand(sessionId: string, terminalId: string, entryId: string, output: string, exitCode: number | null, disconnected: boolean): void {
    this.transaction(() => {
      this.db.prepare("UPDATE terminalEntries SET output=?,exitCode=? WHERE id=? AND terminalId=?")
        .run(output, exitCode, entryId, terminalId);
      this.db.prepare("UPDATE terminals SET status=?,holder=? WHERE id=? AND sessionId=?")
        .run(disconnected ? "disconnected" : "ready", disconnected ? null : this.terminal(sessionId, terminalId).holder, terminalId, sessionId);
      this.event(sessionId, "terminal");
    });
  }

  setTerminalStatus(sessionId: string, terminalId: string, status: TerminalSession["status"]): void {
    this.terminal(sessionId, terminalId);
    this.db.prepare("UPDATE terminals SET status=? WHERE id=?").run(status, terminalId);
    this.event(sessionId, "terminal");
  }

  terminalOutput(sessionId: string, terminalId: string, output: string): void {
    this.terminal(sessionId, terminalId);
    this.db.prepare("UPDATE terminals SET output=? WHERE id=?").run(output, terminalId);
    this.event(sessionId, "terminal");
  }

  disconnectTerminal(sessionId: string, terminalId: string): void {
    this.transaction(() => {
      const terminal = this.terminal(sessionId, terminalId);
      if (terminal.status === "disconnected") return;
      this.db.prepare("UPDATE terminals SET status='disconnected',holder=NULL WHERE id=?").run(terminalId);
      this.event(sessionId, "terminal");
    });
  }
}
