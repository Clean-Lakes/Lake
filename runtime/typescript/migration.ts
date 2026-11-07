import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import type { AICard, AIView, Message, Project, Resource, WorkSession } from "../../web-agent/shared/contracts";
import { HttpError, id, LakeStore, now, type StoredSession } from "./store";
import { digest } from "./tasks";
import type {LakeSSH} from './ssh';
import type {LakeMySQL} from './mysql';
import type {LakeSecurity} from './security';
import type {McpBinding} from './extensions';

const tables = ["projects", "resources", "resourceTree", "sessions", "messages", "workspaceTags", "sessionPresentation", "sessionTags", "sessionNavigation", "projectSessionNavigation", "navigationTrash", "aiScopes", "superagentRoleChannels", "superagentChannelReads", "superagentChannelTimeline"];
const runtimeTables = ["superagent_projects", "superagent_roles", "superagent_role_channels", "superagent_workers", "native_work_goals", "native_operations", "security_project_policies", "security_legacy_session_policies"];
const safeId = (value: unknown) => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,199}$/.test(value);
type Migration = { id: string; source: string; sourceFingerprint: string; importedAt: string; counts: Record<string, number>;
  writes: { kind: string; id: string; hash: string }[]; projectIds: string[] };

async function fingerprint(path: string) {
  const result: Record<string, unknown> = {};
  for (const suffix of ["", "-wal"]) try {
    const info = await lstat(path + suffix, { bigint: true });
    result[suffix || "main"] = { size: String(info.size), mtime: String(info.mtimeNs), inode: String(info.ino) };
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return digest(result);
}
async function openLegacy(path: string, home?: string) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || (process.platform !== "win32" && info.uid !== process.getuid?.()))
      throw new HttpError(403, "旧 Dev 数据库必须是当前用户的私有普通文件");
    if (home && !(await realpath(path)).startsWith((await realpath(home)) + sep)) throw new HttpError(403, "旧数据库不能指向 Home 之外");
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  const db = new DatabaseSync(path, { readOnly: true });
  db.exec("PRAGMA query_only=ON; BEGIN");
  return db;
}
const exists = (db: DatabaseSync, table: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);

// Restore project choices from the original authority, never grants, owners or
// operations. Incremental receipts keep restarts from reimporting deleted data.
export async function importLegacyMCP(store: LakeStore, security: LakeSecurity) {
  const authority = security.authority();
  if (!authority) return;
  const path = join(store.data, 'adk/sessions.sqlite'), db = await openLegacy(path, store.home);
  if (!db) return;
  try {
    const before = await fingerprint(path);
    const meta = exists(db, 'security_schema_meta') ? db.prepare('SELECT * FROM security_schema_meta WHERE id=1').get() : undefined;
    if (!meta || meta.store_id !== authority.storeID || meta.recovery_epoch !== authority.recoveryEpoch || meta.migration_state !== 'ready')
      throw new HttpError(409, '原 MCP 安全权威尚未就绪');
    const writes: { kind: string; key: string; receipt: string; value: McpBinding; sourceHash: string }[] = [];
    const add = (kind: string, key: string, value: McpBinding, source: unknown) => {
      const receipt = digest([kind, key]);
      if (store.get(kind, key) || store.get('legacyMcpChoices', receipt)) return;
      writes.push({kind, key, receipt, value: {...value, LegacyAuthority: authority}, sourceHash: digest(source)});
    };
    if (exists(db, 'security_authority_events')) for (const project of store.list<Project>('projects')) {
      const row = db.prepare("SELECT result,after_revision FROM security_authority_events WHERE kind='mcp.inheritance' AND project_id=? AND object_id=? AND store_id=? AND recovery_epoch=? ORDER BY after_revision DESC LIMIT 1")
        .get(project.id, project.id, authority.storeID, authority.recoveryEpoch);
      if (!row) continue;
      let value: McpBinding; try { value = JSON.parse(String(row.result)); } catch { throw new HttpError(409, '原 MCP 继承记录无效'); }
      if (value.ProjectID !== project.id || typeof value.Enabled !== 'boolean' || value.Revision !== Number(row.after_revision) ||
          !Number.isSafeInteger(value.Revision) || value.Revision < 1 || value.Revision >= 2 ** 50)
        throw new HttpError(409, '原 MCP 继承记录版本冲突');
      add('mcpInheritance', project.id, {ProjectID: project.id, Enabled: value.Enabled, Revision: value.Revision}, row);
    }
    if (exists(db, 'security_mcp_bindings')) for (const row of db.prepare('SELECT * FROM security_mcp_bindings').all()) {
      const project = String(row.project_id), server = String(row.server_id);
      if (!store.get('projects', project)) continue;
      if (!safeId(server)) throw new HttpError(409, '原 MCP 服务身份无效');
      const valid = row.store_id === authority.storeID && row.recovery_epoch === authority.recoveryEpoch &&
        Number.isSafeInteger(Number(row.revision)) && Number(row.revision) >= 1 && Number(row.revision) < 2 ** 50;
      let names: unknown; try { names = JSON.parse(String(row.tool_names)); } catch { names = undefined; }
      const catalogValid = Array.isArray(names) && names.length <= 1000 && names.every(name => typeof name === 'string') && new Set(names).size === names.length;
      // A stale explicit binding must still override inherited access with a deny.
      add('mcpBindings', digest([project, server]), {ProjectID: project, ServerID: server, Revision: valid ? Number(row.revision) : 1,
        Enabled: valid && catalogValid && row.enabled === 1, ToolNames: catalogValid ? names as string[] : []}, row);
    }
    security.check();
    if (digest(security.authority()) !== digest(authority) || await fingerprint(path) !== before)
      throw new HttpError(409, '原 MCP 权威正在变化，本次迁移未提交');
    store.transaction(() => { for (const entry of writes) {
      if (store.get(entry.kind, entry.key) || store.get('legacyMcpChoices', entry.receipt)) continue;
      store.put(entry.kind, entry.key, entry.value);
      store.put('legacyMcpChoices', entry.receipt, {kind: entry.kind, id: entry.key, sourceHash: entry.sourceHash, authority, importedAt: now()});
    } });
  } finally { db.close(); }
}

// Catalog v1 intentionally retained only metadata. Supplement exact SSH config
// references without rewriting that batch's immutable receipts or old Go data.
export async function importLegacySSH(store:LakeStore,ssh:LakeSSH) {
 const source=join(store.data,'lake-web.sqlite'),db=await openLegacy(source,store.home);if(!db)return;
 try {
  if(!exists(db,'resourceConnections'))return;
  const before=await fingerprint(source);
  const candidates=db.prepare("SELECT r.id,r.projectId,c.config FROM resources r JOIN resourceConnections c ON c.resourceId=r.id WHERE r.kind='ssh'").all();
  const prepared:{resource:Resource;hash:string}[]=[];
  for(const row of candidates){
   const resource=store.get<Resource>('resources',String(row.id)),legacy=store.get<any>('legacyResources',String(row.id));
   if(!resource||!legacy||resource.kind!=='ssh'||resource.projectId!==row.projectId||resource.ssh||store.get('legacySSHConnections',resource.id))continue;
   try{const config=ssh.configuration(JSON.parse(String(row.config)));prepared.push({resource:{...resource,ssh:config,status:legacy.originalStatus==='available'?'available':'unavailable'},hash:digest(String(row.config))});}
   catch {store.put('legacySSHConnectionErrors',resource.id,{resourceId:resource.id,reason:'SSH 连接配置或 Dev 凭据引用需核实'});}
  }
  if(await fingerprint(source)!==before)throw new HttpError(409,'旧连接配置正在变化，SSH 增量导入未提交');
  store.transaction(()=>{for(const item of prepared){store.put('resources',item.resource.id,item.resource);store.put('resourceRevisions',item.resource.id,(store.get<number>('resourceRevisions',item.resource.id)??1)+1);
   store.put('legacySSHConnections',item.resource.id,{resourceId:item.resource.id,sourceHash:item.hash,importedAt:now(),source:'go-resourceConnections'});}});
 }finally{db.close();}
}
// Import exact saved MySQL references only; original Go data and execution history stay untouched.
export async function importLegacyMySQL(store:LakeStore,mysql:LakeMySQL){
 const source=join(store.data,'lake-web.sqlite'),db=await openLegacy(source,store.home);if(!db)return;
 try{
  if(!exists(db,'resourceConnections'))return;
  const before=await fingerprint(source),prepared:{resource:Resource;hash:string}[]=[];
  for(const row of db.prepare("SELECT r.id,r.projectId,c.config FROM resources r JOIN resourceConnections c ON c.resourceId=r.id WHERE r.kind='database'").all()){
   const resource=store.get<Resource>('resources',String(row.id)),legacy=store.get<any>('legacyResources',String(row.id));
   if(!resource||!legacy||resource.kind!=='database'||resource.projectId!==row.projectId||resource.settings?.driver||store.get('legacyMySQLConnections',resource.id))continue;
   try{const raw=JSON.parse(String(row.config));if(raw.driver!=='mysql')continue;const settings=mysql.configuration(raw);prepared.push({resource:{...resource,settings,status:legacy.originalStatus==='available'?'available':'unavailable'},hash:digest(String(row.config))});}
   catch{store.put('legacyMySQLConnectionErrors',resource.id,{resourceId:resource.id,reason:'MySQL 连接或 Dev 凭据引用需核实'});}
  }
  if(await fingerprint(source)!==before)throw new HttpError(409,'旧连接配置正在变化，MySQL 增量导入未提交');
  store.transaction(()=>{for(const item of prepared){store.put('resources',item.resource.id,item.resource);store.put('resourceRevisions',item.resource.id,(store.get<number>('resourceRevisions',item.resource.id)??1)+1);store.put('legacyMySQLConnections',item.resource.id,{resourceId:item.resource.id,sourceHash:item.hash,importedAt:now(),source:'go-resourceConnections'});}});
 }finally{db.close();}
}
function rows(db: DatabaseSync | undefined, table: string): Record<string, any>[] {
  if (!db || !exists(db, table)) return [];
  // Names are compile-time whitelisted, never supplied by an HTTP request/model.
  if (![...tables, ...runtimeTables].includes(table)) throw new Error("Unknown migration table");
  return db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all() as Record<string, any>[];
}
function clean<T>(value: T, redact: (text: string) => string): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map((item) => clean(item, redact)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, typeof item === "string" && /(?:api.?key|password|private.?key|authorization|credentialValue)/i.test(key) ? "[REDACTED]" : clean(item, redact)])) as T;
  return value;
}
export async function previewLegacyMigration(store: LakeStore) {
  const source = join(store.data, "lake-web.sqlite"), db = await openLegacy(source, store.home);
  if (!db) return { source, available: false, fingerprint: "", counts: {} as Record<string, number> };
  try {
    const counts = Object.fromEntries(tables.filter((table) => exists(db, table)).map((table) => [table, Number(db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get()?.n)]));
    return { source, available: true, fingerprint: await fingerprint(source), counts };
  } finally { db.close(); }
}

// Import presentation and stable identity only. No legacy ADK session, lease,
// task permit, approval or operation is converted into a native execution owner.
export async function applyLegacyMigration(store: LakeStore, redact: (text: string) => string, expectedFingerprint?: string) {
  const previous = store.get<Migration>("settings", "legacyCatalogMigration.v1");
  if (previous) return previous;
  const source = join(store.data, "lake-web.sqlite"), runtimePath = join(store.data, "adk/sessions.sqlite");
  const web = await openLegacy(source, store.home);
  if (!web) return;
  let runtime: DatabaseSync | undefined;
  try {
    runtime = await openLegacy(runtimePath, store.home);
    const before = await fingerprint(source), runtimeBefore = await fingerprint(runtimePath);
    if (expectedFingerprint && before !== expectedFingerprint) throw new HttpError(409, "旧目录在预览后发生变化，请重新预览");
    const data = Object.fromEntries(tables.map((table) => [table, rows(web, table)]));
    const canonical = Object.fromEntries(runtimeTables.map((table) => [table, rows(runtime, table)]));
    const archivedProjects = new Set(data.navigationTrash.filter((entry) => entry.kind === "project").map((entry) => entry.id));
    const projects = data.projects.filter((project) => !archivedProjects.has(project.id));
    const projectIds = new Set(projects.map((project) => project.id));
    for (const project of projects) if (!safeId(project.id)) throw new HttpError(409, "旧项目身份无效，迁移已停止");
    const sessions = data.sessions.filter((session) => projectIds.has(session.projectId));
    const sessionIds = new Set(sessions.map((session) => session.id));
    const domains = new Map(canonical.superagent_projects.filter((project) => projectIds.has(project.project_id)).map((project) => [project.router_session_id, project]));
    const channels = new Map(canonical.superagent_role_channels.filter((channel) => projectIds.has(channel.project_id)).map((channel) => [channel.host_session_id, channel]));
    const permissions = new Map(canonical.security_legacy_session_policies.filter((policy) => sessionIds.has(policy.session_id)).map((policy) => [policy.session_id, JSON.parse(policy.data)]));
    const batch: Migration = { id: id(), source, sourceFingerprint: digest([before, runtimeBefore]), importedAt: now(), counts: {}, writes: [], projectIds: [...projectIds] };
    const writes: { kind: string; id: string; value: any }[] = [];
    const put = (kind: string, key: string, value: any) => {
      const sanitized = clean(value, redact);
      if (store.get(kind, key)) throw new HttpError(409, `TS ${kind} identity already exists; refusing to overwrite user data`);
      writes.push({ kind, id: key, value: sanitized });
      batch.counts[kind] = (batch.counts[kind] ?? 0) + 1;
    };
    for (const project of projects) {
      put("projects", project.id, { id: project.id, name: project.name, createdAt: project.createdAt } satisfies Project);
      const localId = "ts_local_" + digest(project.id).slice(0, 24);
      put("resources", localId, { id: localId, projectId: project.id, name: "TS 项目工作区", kind: "local", description: "TS 内核的独立项目工作区", status: "available", settings: { shell: "zsh" } } satisfies Resource);
    }
    const archivedResources = new Set(data.navigationTrash.filter((entry) => entry.kind === "resource").map((entry) => entry.id));
    for (const resource of data.resources.filter((resource) => projectIds.has(resource.projectId) && !archivedResources.has(resource.id))) {
      if (!safeId(resource.id)) throw new HttpError(409, "旧资源身份无效，迁移已停止");
      put("resources", resource.id, { id: resource.id, projectId: resource.projectId, name: resource.name, kind: resource.kind,
        description: resource.description, status: "unavailable" } as Resource);
      put("legacyResources", resource.id, { source: "go", projectId: resource.projectId, originalStatus: resource.status, readOnly: true, importedAt: batch.importedAt });
    }
    for (const node of data.resourceTree.filter((node) => projectIds.has(node.projectId) && (!node.resourceId || !archivedResources.has(node.resourceId)))) put("tree", node.id, node);
    for (const session of sessions) {
      if (!safeId(session.id)) throw new HttpError(409, "旧会话身份无效，迁移已停止");
      const role: WorkSession["workspaceRole"] = domains.has(session.id) ? "router" : channels.has(session.id) ? "role" : "legacy";
      put("sessions", session.id, { id: session.id, projectId: session.projectId, title: session.title, status: "idle", resourceIds: [], createdAt: session.createdAt,
        updatedAt: session.updatedAt, workspaceRole: role, options: { conversationMode: "default", agentRuntime: "typescript", profile: "core", maxSteps: 500, runtime: "local", ignoreNaturalMemory: true,
          ...Object.fromEntries(["silentMCPCalls", "silentReadFiles", "silentWriteFiles", "silentReadSQL", "silentCommands", "silentTerminalCreation", "blockUnreferencedAssets", "denyLocalExecution"]
            .filter((key) => typeof permissions.get(session.id)?.[key] === "boolean").map((key) => [key, permissions.get(session.id)[key]])) } } satisfies StoredSession);
      put("legacySessionSources", session.id, { batchId: batch.id, projectId: session.projectId, originalStatus: session.status,
        viewPath: join(store.data, "ai", session.id + ".json"), readOnly: role === "legacy", source: "go-ui-cache" });
    }
    for (const message of data.messages.filter((message) => sessionIds.has(message.sessionId))) put("messages", message.id, {
      id: message.id, sessionId: message.sessionId, role: message.role, text: message.text, createdAt: message.createdAt,
      images: typeof message.images === "string" ? JSON.parse(message.images || "[]") : undefined,
      files: typeof message.files === "string" ? JSON.parse(message.files || "[]") : undefined,
    } satisfies Message);
    for (const tag of data.workspaceTags.filter((tag) => projectIds.has(tag.projectId))) put("tags", tag.id, tag);
    for (const presentation of data.sessionPresentation.filter((item) => sessionIds.has(item.sessionId))) put("sessionPresentation", presentation.sessionId, {
      icon: presentation.icon, revision: presentation.revision,
      tagIds: data.sessionTags.filter((tag) => tag.sessionId === presentation.sessionId).map((tag) => tag.tagId),
    });
    for (const position of data.sessionNavigation.filter((item) => sessionIds.has(item.sessionId))) put("sessionNavigation", position.sessionId, { pinned: !!position.pinned, position: position.position });
    for (const revision of data.projectSessionNavigation.filter((item) => projectIds.has(item.projectId))) put("navigationRevisions", revision.projectId, Number(revision.revision));
    for (const scope of data.aiScopes.filter((item) => sessionIds.has(item.sessionId))) put("aiScopes", scope.sessionId, { scope: scope.scope });
    for (const policy of canonical.security_project_policies.filter((policy) => projectIds.has(policy.project_id)))
      put("legacyProjectPolicies", policy.project_id, { projectId: policy.project_id, revision: policy.revision, mode: policy.mode, readOnly: true, data: JSON.parse(policy.data) });
    for (const role of canonical.superagent_roles.filter((role) => projectIds.has(role.project_id))) put("superRoles", role.id, {
      id: role.id, projectId: role.project_id, roleKey: role.role_key, name: role.name, duties: role.duties ?? "", revision: Number(role.revision), deletedAt: role.deleted_at || undefined,
    });
    for (const domain of domains.values()) if (sessionIds.has(domain.router_session_id)) put("superProjects", domain.project_id, { projectId: domain.project_id, routerSessionId: domain.router_session_id, version: 1 });
    for (const channel of channels.values()) if (sessionIds.has(channel.host_session_id)) put("superChannels", channel.role_id, {
      id: channel.id, projectId: channel.project_id, roleId: channel.role_id, sessionId: channel.host_session_id, revision: Number(channel.revision), createdAt: channel.created_at,
    });
    const channelIds = new Set([...channels.values()].map((channel) => channel.id));
    for (const row of data.superagentChannelReads.filter((row) => channelIds.has(row.channelId)))
      put("legacyChannelReads", row.channelId, { cursor: row.completionCursor });
    for (const row of data.superagentChannelTimeline.filter((row) => channelIds.has(row.channelId) && sessionIds.has(row.sourceSessionId)))
      put("legacyChannelTimeline", digest([row.channelId, row.kind, row.sourceSessionId, row.sourceId]), row);
    for (const goal of canonical.native_work_goals.filter((goal) => sessionIds.has(goal.session_id))) {
      let value: any; try { value = JSON.parse(goal.data); } catch { throw new HttpError(409, "旧任务正文损坏，迁移已停止"); }
      put("legacyGoals", goal.id, { ...value, projectId: sessions.find((session) => session.id === goal.session_id)!.projectId, source: "go", readOnly: true, originalStatus: goal.status });
    }
    for (const worker of canonical.superagent_workers.filter((worker) => projectIds.has(worker.project_id))) put("legacyWorkers", worker.id, {
      id: worker.id, projectId: worker.project_id, roleId: worker.role_id, sessionId: worker.session_id, taskId: worker.task_id, sourceEventId: worker.source_event_id,
      roleSnapshot: worker.role_snapshot ? JSON.parse(worker.role_snapshot) : undefined, createdAt: worker.created_at, revision: worker.revision, readOnly: true,
    });
    for (const operation of canonical.native_operations.filter((operation) => projectIds.has(operation.project_id))) put("legacyOperations", operation.id, {
      id: operation.id, projectId: operation.project_id, sessionId: operation.session_id, goalId: operation.goal_id, stepId: operation.step_id,
      status: operation.status, tool: operation.tool, argsHash: operation.args_hash, resourceId: operation.resource_id,
      resourceConnectionRevision: operation.resource_connection_revision, readOnly: true, source: "go",
      riskResolvedAt: operation.risk_resolved_at, orphanState: operation.orphan_state,
    });
    if (await fingerprint(source) !== before || await fingerprint(runtimePath) !== runtimeBefore) throw new HttpError(409, "旧数据库仍有写入，迁移未提交");
    store.transaction(() => {
      for (const write of writes) { store.put(write.kind, write.id, write.value); batch.writes.push({ kind: write.kind, id: write.id, hash: digest(write.value) }); }
      store.put("settings", "legacyCatalogMigration.v1", batch);
      store.put("legacyMigrationBatches", batch.id, batch);
    });
    return batch;
  } finally { runtime?.close(); web.close(); }
}

export function rollbackMigration(store: LakeStore, batchId: string) {
  return store.transaction(() => {
    const batch = store.require<Migration>("legacyMigrationBatches", batchId);
    if (store.list<{ projectId: string }>("superWorkers").some((worker) => batch.projectIds.includes(worker.projectId)))
      throw new HttpError(409, "迁入项目已有 TS 任务，不能回退删除其数据");
    const sessionIds = new Set(batch.writes.filter((write) => write.kind === "sessions").map((write) => write.id));
    const importedMessages = new Set(batch.writes.filter((write) => write.kind === "messages").map((write) => write.id));
    if (store.list<Message>("messages").some((message) => sessionIds.has(message.sessionId) && !importedMessages.has(message.id)))
      throw new HttpError(409, "迁入会话已有新消息，不能回退覆盖");
    for (const write of batch.writes) if (digest(store.get(write.kind, write.id)) !== write.hash)
      throw new HttpError(409, "迁入数据已变更，不能回退删除新修改");
    for (const write of batch.writes) store.delete(write.kind, write.id);
    for (const sessionId of sessionIds) { store.delete("legacyLoadedViews", sessionId); store.delete("views", sessionId); }
    store.delete("settings", "legacyCatalogMigration.v1"); store.delete("legacyMigrationBatches", batchId);
    return { rolledBack: true, batchId };
  });
}

export async function loadLegacyView(store: LakeStore, sessionId: string, redact: (value: string) => string) {
  const ref = store.get<{ viewPath: string; readOnly: boolean }>("legacySessionSources", sessionId);
  if (!ref || store.get("legacyLoadedViews", sessionId)) return;
  let state: any;
  try {
    const info = await lstat(ref.viewPath);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.size > 64 * 1024 * 1024 ||
        process.platform !== "win32" && info.uid !== process.getuid?.() || !(await realpath(ref.viewPath)).startsWith((await realpath(store.home)) + sep))
      throw new HttpError(409, "旧会话快照需单独校验，原文件已保留");
    state = JSON.parse(await readFile(ref.viewPath, "utf8"));
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  // The committed ADK state selects an exact artifact version/hash. Later
  // orphan artifacts never replace it. JSON is only a pre-ADK cache fallback.
  let source = "go-ui-cache";
  const db = await openLegacy(join(store.data, "adk/sessions.sqlite"), store.home);
  try {
    const checkpoint = state?.runtime?.sessionId;
    const migration = db && exists(db, "native_history_migrations") ? db.prepare("SELECT runtime_session_id FROM native_history_migrations WHERE session_id=? AND status='complete' ORDER BY created_at DESC LIMIT 1").get(sessionId) : undefined;
    const runtimeId = checkpoint ?? migration?.runtime_session_id;
    if (db && runtimeId && exists(db, "sessions") && exists(db, "native_artifacts")) {
      const row = db.prepare("SELECT state FROM sessions WHERE app_name='lake' AND user_id='lake' AND id=?").get(runtimeId);
      const pointer = row && JSON.parse(String(row.state)).lake_context_projection;
      if (pointer) {
        if (!Number.isSafeInteger(pointer.version) || pointer.version < 1 || typeof pointer.hash !== "string") throw new HttpError(409, "旧 ADK 历史引用损坏");
        const artifact = db.prepare("SELECT part FROM native_artifacts WHERE session_id=? AND file_name='lake-context.json' AND version=?").get(runtimeId, pointer.version);
        if (!artifact) throw new HttpError(409, "旧 ADK 历史引用缺少正文");
        const part = JSON.parse(Buffer.from(artifact.part as Uint8Array).toString("utf8"));
        if (typeof part.text !== "string" || createHash("sha256").update(part.text).digest("hex") !== pointer.hash) throw new HttpError(409, "旧 ADK 历史校验失败");
        state = JSON.parse(part.text); source = "go-adk-committed-projection";
      }
    }
  } finally { db?.close(); }
  if (!state) return;
  if (!state.view || state.view.session !== sessionId || !Array.isArray(state.view.cards)) throw new HttpError(409, "旧会话快照身份无效");
  const cards: AICard[] = clean(state.view.cards.map((card: any) => ({ id: card.id, type: card.type, title: card.title, content: card.content,
    data: card.data, status: ["running", "pending"].includes(card.status) ? "interrupted" : card.status, at: card.at })), redact);
  // Merge only historical presentation. Never import Runtime, Config, pending
  // approvals/questions, ownership, Memory settings or executable tool calls.
  const current = store.view(sessionId), existing = new Set(current.cards.map((card) => card.id));
  current.cards = [...cards.filter((card) => !existing.has(card.id)), ...current.cards]; current.totalCards = current.cards.length;
  store.transaction(() => { store.put("views", sessionId, current); store.put("legacyLoadedViews", sessionId, { source, at: now(), retainedSource: true }); });
}
