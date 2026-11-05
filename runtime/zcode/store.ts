import { DatabaseSync } from "node:sqlite";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Position, Presentation } from "./navigation";
import type {
  AIView,
  Catalog,
  Message,
  ModelProvider,
  Project,
  Resource,
  SessionEvent,
  SessionSnapshot,
  WorkSession,
  ResourceTreeNode,
  WorkspaceTag,
} from "../../web-agent/shared/contracts";

export const now = () => new Date().toISOString();
export const id = () => randomUUID();
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export type Provider = ModelProvider;
export type StoredSession = WorkSession & { options: Record<string, unknown> };

export async function privateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.uid !== process.getuid?.() && process.platform !== "win32")
  )
    throw new Error("Lake private directory is not owned by the current user");
  await chmod(path, 0o700);
}

export class LakeStore {
  private constructor(
    public home: string,
    public data: string,
    readonly db: DatabaseSync,
  ) {}
  static async open(home: string, data: string) {
    await privateDirectory(home);
    await privateDirectory(data);
    const file = join(data, "lake-typescript.sqlite");
    try {
      if ((await lstat(file)).isSymbolicLink())
        throw new Error("Lake database must not be a symlink");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const db = new DatabaseSync(file);
    await chmod(file, 0o600);
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,session TEXT NOT NULL,value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS session_events ON events(session,seq);`);
    const store = new LakeStore(home, data, db);
    // A restart never resumes a model/tool request from a UI projection.
    for (const session of store.list<StoredSession>("sessions")) {
      const view = store.view(session.id);
      if (["running", "waiting_approval", "waiting_input"].includes(view.status)) {
        view.status = "interrupted";
        view.pending = undefined;
        view.pendingApprovals = [];
        view.question = undefined;
        for (const card of view.cards)
          if (["running", "pending"].includes(card.status)) card.status = "interrupted";
        store.put("views", session.id, view);
      }
    }
    return store;
  }
  get<T>(kind: string, key: string): T | undefined {
    const row = this.db.prepare("SELECT value FROM records WHERE kind=? AND id=?").get(kind, key);
    return row ? (JSON.parse(String(row.value)) as T) : undefined;
  }
  require<T>(kind: string, key: string): T {
    const value = this.get<T>(kind, key);
    if (!value) throw new HttpError(404, "记录不存在");
    return value;
  }
  list<T>(kind: string): T[] {
    return this.db
      .prepare("SELECT value FROM records WHERE kind=? ORDER BY rowid")
      .all(kind)
      .map((row) => JSON.parse(String(row.value)) as T);
  }
  put<T>(kind: string, key: string, value: T): T {
    this.db
      .prepare(
        "INSERT INTO records(kind,id,value) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value",
      )
      .run(kind, key, JSON.stringify(value));
    return value;
  }
  delete(kind: string, key: string) {
    this.db.prepare("DELETE FROM records WHERE kind=? AND id=?").run(kind, key);
  }
  transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  project(projectId: string) {
    return this.require<Project>("projects", projectId);
  }
  session(sessionId: string) {
    const session = this.require<StoredSession>("sessions", sessionId);
    const presentation = this.get<Presentation>("sessionPresentation", sessionId);
    const position = this.get<Position>("sessionNavigation", sessionId);
    const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
    const tags = (presentation?.tagIds ?? [])
      .map((id) => this.get<WorkspaceTag>("tags", id))
      .filter((tag): tag is WorkspaceTag => !!tag && tag.projectId === session.projectId)
      .sort((a, b) => compare(a.name, b.name) || compare(a.id, b.id));
    // Derived metadata cannot be replaced by a stale model/runtime session write.
    return {
      ...session,
      icon: presentation?.icon ?? "chat",
      presentationRevision: presentation?.revision ?? 0,
      tags,
      pinned: position?.pinned ?? false,
      navigationPosition: position?.position,
      navigationRevision: this.get<number>("navigationRevisions", session.projectId) ?? 0,
    };
  }
  createProject(name: string) {
    if (!name.trim()) throw new HttpError(400, "项目名称不能为空");
    const project: Project = { id: id(), name: name.trim(), createdAt: now() };
    this.put("projects", project.id, project);
    const resource: Resource = {
      id: id(),
      projectId: project.id,
      name: "本机",
      kind: "local",
      settings: { shell: "zsh" },
      description: "",
      status: "available",
    };
    this.put("resources", resource.id, resource);
    return project;
  }
  catalog(): Catalog {
    const resources = this.list<Resource>("resources");
    const tree = this.list<ResourceTreeNode>("tree");
    for (const resource of resources)
      if (!tree.some((node) => node.resourceId === resource.id))
        tree.push({
          id: resource.id,
          projectId: resource.projectId,
          parentId: null,
          kind: "resource",
          name: resource.name,
          resourceId: resource.id,
          position: tree.length,
        });
    return {
      projects: this.list<Project>("projects"),
      resources,
      resourceTree: tree,
      sessions: this.list<StoredSession>("sessions").filter((session) => !this.list<string>("terminalScopes").includes(session.id)).map(({ id }) => {
        const { options, ...session } = this.session(id);
        return session;
      }),
      tags: this.list("tags"),
      terminals: this.list<import("../../web-agent/shared/contracts").TerminalSession>("terminals").map((terminal) => ({ ...terminal, sessionTitle: this.session(terminal.sessionId).title })),
    };
  }
  createSession(projectId: string) {
    this.project(projectId);
    const session: StoredSession = {
      id: id(),
      projectId,
      title: "新对话",
      status: "idle",
      resourceIds: [],
      createdAt: now(),
      updatedAt: now(),
      options: {
        conversationMode: "default",
        agentRuntime: "zcode",
        profile: "core",
        runtime: "local",
        userPrompt: "",
        contextBudgetMode: "auto",
        contextWindow: 128000,
        maxOutput: 8192,
        maxSteps: 500,
      },
    };
    this.put("sessions", session.id, session);
    return this.session(session.id);
  }
  view(sessionId: string): AIView {
    return (
      this.get<AIView>("views", sessionId) ?? {
        session: sessionId,
        status: "idle",
        cards: [],
        agentRuns: [],
        usage: { input: 0, output: 0, total: 0 },
        profile: "core",
        turns: 0,
        cardsOffset: 0,
        totalCards: 0,
      }
    );
  }
  messages(sessionId: string) {
    return this.list<Message>("messages").filter((message) => message.sessionId === sessionId);
  }
  viewPage(sessionId: string, before?: number, limit = 300): AIView {
    const view = this.view(sessionId), total = view.cards.length;
    const end = before == null ? total : before;
    if (!Number.isSafeInteger(end) || end < 0 || end > total) throw new HttpError(400, "无效的历史分页位置");
    const start = Math.max(0, end - limit);
    return { ...view, cards: view.cards.slice(start, end), cardsOffset: start, totalCards: total };
  }
  addMessage(sessionId: string, role: Message["role"], text: string) {
    const message: Message = { id: id(), sessionId, role, text, createdAt: now() };
    return this.put("messages", message.id, message);
  }
  cursor(sessionId: string) {
    return Number(
      this.db
        .prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE session=?")
        .get(sessionId)?.seq ?? 0,
    );
  }
  event(
    sessionId: string,
    type: SessionEvent["type"] = "session",
    extra: Partial<SessionEvent> = {},
  ) {
    const event: SessionEvent = { seq: 0, sessionId, type, createdAt: now(), ...extra };
    const inserted = this.db
      .prepare("INSERT INTO events(session,value) VALUES(?,?)")
      .run(sessionId, JSON.stringify(event));
    event.seq = Number(inserted.lastInsertRowid);
    return event;
  }
  events(sessionId: string, after: number) {
    return this.db
      .prepare("SELECT seq,value FROM events WHERE session=? AND seq>? ORDER BY seq LIMIT 2000")
      .all(sessionId, after)
      .map((row) => ({ ...JSON.parse(String(row.value)), seq: Number(row.seq) }) as SessionEvent);
  }
  snapshot(sessionId: string): SessionSnapshot {
    const session = this.session(sessionId);
    const catalog = this.catalog();
    const { options, ...publicSession } = session;
    return {
      session: publicSession,
      resources: catalog.resources.filter((resource) => resource.projectId === session.projectId),
      resourceTree: catalog.resourceTree?.filter((node) => node.projectId === session.projectId),
      messages: this.messages(sessionId),
      specialists: [],
      evidence: [],
      actions: [],
      terminals: (catalog.terminals ?? []).filter((terminal) => terminal.sessionId === sessionId),
      cursor: this.cursor(sessionId),
      ai: this.view(sessionId),
      conversationMode: options.conversationMode === "plan" ? "plan" : "default",
      messageQueue: { paused: false, revision: 0, lastError: "", items: [] },
    };
  }
  async secret(providerId: string, value?: string | null) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/.test(providerId))
      throw new HttpError(400, "Invalid provider identity");
    const directory = join(this.home, "secrets");
    await privateDirectory(directory);
    const file = join(directory, `model-${providerId}.json`);
    if (value === null) {
      this.delete("providerCredentialRefs", providerId);
      await unlink(file).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      return "";
    }
    if (value !== undefined) {
      const temp = join(directory, `.${id()}.tmp`);
      const handle = await open(temp, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ apiKey: value }));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, file);
      this.delete("providerCredentialRefs", providerId);
      return value;
    }
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
        throw new Error("Model secret permissions are invalid");
      return String(JSON.parse(await readFile(file, "utf8")).apiKey ?? "");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const ref = this.get<string>("providerCredentialRefs", providerId);
        if (!ref) return "";
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,199}$/.test(ref))
          throw new Error("Dev model credential reference is invalid");
        const legacyFile = join(directory, ref);
        const info = await lstat(legacyFile);
        if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
            (process.platform !== "win32" && info.uid !== process.getuid?.()) || info.size > 4096)
          throw new Error("Dev model credential permissions are invalid");
        return readFile(legacyFile, "utf8");
      }
      throw error;
    }
  }
  async workspace(projectId: string) {
    this.project(projectId);
    const settings = this.get<{ workspace?: string }>("projectSettings", projectId);
    const directory = resolve(settings?.workspace ?? join(this.home, "workspaces", projectId));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return realpath(directory);
  }
  close() {
    this.db.close();
  }
}
