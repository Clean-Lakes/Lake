import {isNativeAgentSource,isNativeControlSource} from "../../web-agent/shared/runtime-compat";
import { DatabaseSync } from "node:sqlite";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type {LakeMagpie} from './magpie';
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
  magpie?: LakeMagpie;
  async refreshModels() { await this.magpie?.refresh(); }
  modelProvider(providerId: string) { return providerId === 'magpie' ? this.magpie?.provider() : this.get<ModelProvider>('providers', providerId); }
  modelProviders() { const native = this.list<ModelProvider>('providers').filter(value => value.id !== 'magpie'); const managed = this.magpie?.provider(); return managed ? [...native, managed] : native; }
  modelSelection() {
    type Selection = {providerId: string; modelId: string};
    const valid = (choice: Selection | undefined) => {
      if (!choice || choice.providerId === 'magpie') return false;
      const provider = this.modelProvider(choice.providerId);
      return provider?.enabled && provider.models.some(model => model.id === choice.modelId && model.enabled);
    };
    const selected = this.get<Selection>('settings', 'modelSelection');
    if (valid(selected)) return selected;
    const managed = this.magpie?.selectedId();
    if (managed) return {providerId: 'magpie', modelId: managed};
    const native = this.get<Selection>('settings', 'nativeModelSelection');
    return valid(native) ? native : undefined;
  }
  selectModel(providerId: string, modelId: string) {
    const provider = this.modelProvider(providerId);
    if (!provider?.enabled || !provider.models.some(model => model.id === modelId && model.enabled)) throw new HttpError(400, '模型不可用');
    this.transaction(() => {
      const previous = this.modelSelection();
      if (providerId === 'magpie') {
        if (previous && previous.providerId !== 'magpie') this.put('settings', 'nativeModelSelection', previous);
        this.magpie!.select(modelId);
      } else this.put('settings', 'nativeModelSelection', {providerId, modelId});
      this.put('settings', 'modelSelection', {providerId, modelId});
    });
  }
  async modelCredential(provider: ModelProvider) { return provider.id === 'magpie' ? this.magpie?.credential(provider) : this.secret(provider.id); }
  modelConnectionVersion(provider: ModelProvider) { return provider.id === 'magpie' ? this.magpie?.version(provider) : undefined; }
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
      CREATE INDEX IF NOT EXISTS messages_by_session ON records(json_extract(value,'$.sessionId')) WHERE kind='messages';
      CREATE INDEX IF NOT EXISTS unsettled_ops_by_goal ON records(json_extract(value,'$.goalId'))
        WHERE kind='superOperations' AND json_extract(value,'$.status') IN ('unknown','dispatched');
      CREATE INDEX IF NOT EXISTS session_events ON events(session,seq);`);
    const store = new LakeStore(home, data, db);
    // A restart never resumes a model/tool request from a UI projection.
    for (const session of store.list<StoredSession>("sessions")) {
      const view = store.view(session.id);
      let changed = false;
      if (["running", "waiting_approval", "waiting_input"].includes(view.status)) {
        view.status = "interrupted";
        view.pending = undefined;
        view.pendingApprovals = [];
        view.question = undefined;
        for (const card of view.cards)
          if (["running", "pending"].includes(card.status)) card.status = "interrupted";
        changed = true;
      }
      for (const run of view.agentRuns ?? []) {
        if (!isNativeAgentSource(run.source) || !["queued", "running", "waiting_approval", "waiting_input"].includes(run.status)) continue;
        run.status = "interrupted";
        run.finishedAt = now();
        run.pending = undefined;
        run.question = undefined;
        for (const card of run.cards ?? [])
          if (["running", "pending"].includes(card.status)) card.status = "interrupted";
        changed = true;
      }
      if (changed) store.put("views", session.id, view);
    }
    return store;
  }
  get<T>(kind: string, key: string): T | undefined {
    const row = this.db.prepare("SELECT value FROM records WHERE kind=? AND id=?").get(kind, key);
    return row ? (JSON.parse(String(row.value)) as T) : undefined;
  }
  require<T>(kind: string, key: string): T {
    if (['projects', 'resources'].includes(kind)) {
      const itemKind = kind === 'projects' ? 'project' : 'resource';
      if (this.list<{kind: string; id: string}>('navigationTrash').some(item => item.kind === itemKind && item.id === key))
        throw new HttpError(404, '对象已移入回收站，请先恢复');
    }
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
    const trash = this.list<{kind: string; id: string}>('navigationTrash');
    const hidden = (kind: string, key: string) => trash.some(item => item.kind === kind && item.id === key);
    const resources = this.list<Resource>("resources").filter(resource => !hidden('resource', resource.id) && !hidden('project', resource.projectId)).map(resource=>({...resource,configurationRevision:this.get<number>('resourceRevisions',resource.id)??1}));
    const tree = this.list<ResourceTreeNode>("tree").filter(node => !hidden('project', node.projectId) && !hidden(node.kind, node.resourceId ?? node.id));
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
      projects: this.list<Project>("projects").filter(project => !hidden('project', project.id)),
      resources,
      resourceTree: tree,
      sessions: this.list<StoredSession>("sessions").filter((session) => !hidden('project', session.projectId) && !this.list<string>("terminalScopes").includes(session.id)).map(({ id }) => {
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
        agentRuntime: "typescript",
        profile: "core",
        runtime: "local",
        userPrompt: "",
        contextBudgetMode: "auto",
        contextWindow: 128000,
        maxOutput: 8192,
      },
    };
    this.put("sessions", session.id, session);
    return this.session(session.id);
  }
  view(sessionId: string): AIView {
    const view = (
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
    // Normalize presentation on read; original stored rows remain untouched.
    for (const run of view.agentRuns ?? []) if (isNativeAgentSource(run.source)) run.source = "native_subagent";
    for (const card of [...view.cards, ...(view.agentRuns ?? []).flatMap(run => run.cards ?? [])]) {
      const data = card.data as Record<string, unknown> | undefined;
      if (data && isNativeControlSource(data.source)) data.source = "native_subagent_control";
    }
    return view;
  }
  messages(sessionId: string) {
    // Unread/channel polling reads many sessions. Select before decoding JSON
    // so another conversation's entire history never blocks this session.
    return this.db
      .prepare("SELECT value FROM records WHERE kind='messages' AND json_extract(value,'$.sessionId')=? ORDER BY rowid")
      .all(sessionId)
      .map(row => JSON.parse(String(row.value)) as Message);
  }
  viewPage(sessionId: string, before?: number, limit = 300): AIView {
    const view = this.view(sessionId), total = view.cards.length;
    const end = before == null ? total : before;
    if (!Number.isSafeInteger(end) || end < 0 || end > total) throw new HttpError(400, "无效的历史分页位置");
    const start = Math.max(0, end - limit);
    return { ...view, cards: view.cards.slice(start, end), cardsOffset: start, totalCards: total };
  }
  addMessage(sessionId: string, role: Message["role"], text: string, metadata: Pick<Message, 'mentions' | 'images' | 'files'> = {}) {
    const message: Message = { ...metadata, id: id(), sessionId, role, text, createdAt: now() };
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
      messageQueue: {...(this.get<import('../../web-agent/shared/contracts').MessageQueue>('messageQueues', sessionId) ?? {paused: false, revision: 0, lastError: '', items: []}), pushSupported: false},
      ai: this.view(sessionId),
      conversationMode: options.conversationMode === "plan" ? "plan" : "default",
    };
  }
  async secret(providerId: string, value?: string | null) {
    if (providerId === 'magpie') {
      if (value !== undefined) throw new HttpError(409, 'Magpie 凭据由插件管理');
      const provider = this.magpie?.provider(); return provider ? this.magpie!.credential(provider) : '';
    }
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
