import { createHash } from "node:crypto";

export type RouterEvent = { id: string; projectId: string; sessionId: string; messageId: string; payload: string;
  selectedReferences?: import('./message-input').MessageInput;
  receivedAt: string; revision: number; hash: string; preferredRoleId?: string; explicitTaskId?: string };
export type RouterMessage = { id: string; projectId: string; sessionId: string; sourceSessionId?: string;
  role: "user" | "assistant" | "system"; text: string; createdAt: string; taskId?: string; kind?: "report" | "dispatch" };
export type RouterTask = { taskId: string; projectId: string; roleId: string; sessionId: string; title: string;
  state: string; acceptanceState: string; revision: number; hash: string; updatedAt: string; createdAt?: string;
  summary?: string; archived?: boolean; resourceIds?: string[]; pendingApproval: boolean; unresolvedOperations: number;
  blockers?: { kind?: string; detail: string; observedAt?: string; recordUpdatedAt?: string; capabilityRevision?: string }[] };
export type RouterResource = { id: string; projectId: string; name: string; kind: string; status: string; revision: number;driver?:string };
export type RouterContextInput = { projectId: string; events: RouterEvent[]; messages: RouterMessage[]; tasks: RouterTask[];
  resources: RouterResource[]; agentTools?:string[]; adapters: { ssh: boolean; extensions: boolean;mysql?:boolean }; now: string; maxBytes?: number };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function clip(value: string, maximum: number) {
  const bytes = Buffer.from(value); let end = Math.min(bytes.length, maximum);
  while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}
const mechanicalNotices = new Set(["专员已保留当前进度；尚未取得全部验收证据。", "专员已保留当前工作进度。",
  "这次检查还没完成，已暂停。", "这次检查尚未完成，暂时无法继续。", "这部分工作还没完成。"]);

/** Read-only request projection. Dialogue helps resolve references; it never grants execution. */
export function buildRouterContext(source: RouterContextInput) {
  const events = source.events.filter((event) => event.projectId === source.projectId).slice(0, 16);
  if (!events.length) throw new Error("Router context requires a current project event");
  const maximum = source.maxBytes ?? 16384;
  const scopes = new Set(events.map((event) => event.sessionId)), currentMessages = new Set(events.map((event) => event.messageId));
  const currentStart = new Map([...scopes].map((sessionId) => [sessionId, events.filter((event) => event.sessionId === sessionId).map((event) => event.receivedAt).sort()[0]]));
  const messages = source.messages.filter((message) => message.projectId === source.projectId && scopes.has(message.sessionId) &&
    !currentMessages.has(message.id) && message.role !== "system" && message.kind !== "dispatch" &&
    (message.role !== "user" || message.createdAt < currentStart.get(message.sessionId)!) &&
    !(message.role === "assistant" && mechanicalNotices.has(message.text.trim())))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  // Keep at most four preceding user turns per source channel. Reports arriving
  // between turns stay beside their question, including the latest specialist result.
  const selected = [...scopes].flatMap((sessionId) => {
    const rows = messages.filter((message) => message.sessionId === sessionId);
    const users = rows.flatMap((message, index) => message.role === "user" ? [index] : []);
    return rows.slice(users.at(-4) ?? Math.max(0, rows.length - 8)).slice(-12);
  }).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).slice(-20);
  const recentTasks = new Map<string, string>();
  for (const message of selected) if (message.taskId) recentTasks.set(message.taskId, message.createdAt);
  const explicit = new Set(events.flatMap((event) => event.explicitTaskId ? [event.explicitTaskId] : []));
  const roles = new Set(events.flatMap((event) => event.preferredRoleId ? [event.preferredRoleId] : []));
  const resources = source.resources.filter((resource) => resource.projectId === source.projectId);
  const currentText = events.map((event) => event.payload).join("\n");
  const dialogueText = selected.map((message) => message.text).join("\n");
  const named = new Set(resources.filter((resource) => currentText.includes(resource.id) || currentText.includes(resource.name)).map((resource) => resource.id));
  const mentionedBefore = new Set(resources.filter((resource) => dialogueText.includes(resource.id) || dialogueText.includes(resource.name)).map((resource) => resource.id));
  const score = (task: RouterTask) => (explicit.has(task.taskId) ? 1000 : 0) + (roles.has(task.roleId) ? 100 : 0) +
    (task.resourceIds?.some((id) => named.has(id)) || currentText.includes(task.title) ? 50 : 0) + (recentTasks.has(task.taskId) ? 30 : 0);
  const taskRows = source.tasks.filter((task) => task.projectId === source.projectId && (!roles.size || roles.has(task.roleId) || explicit.has(task.taskId)))
    .sort((a, b) => score(b) - score(a) || (recentTasks.get(b.taskId) ?? b.updatedAt ?? b.createdAt ?? "").localeCompare(recentTasks.get(a.taskId) ?? a.updatedAt ?? a.createdAt ?? "") || a.taskId.localeCompare(b.taskId));
  // Revision describes currently registered adapters and public catalog metadata.
  // It deliberately makes no claim about permission, credentials or reachability.
  const capabilityRevision = hash([source.adapters, resources.map(({ id, kind, status, revision }) => ({ id, kind, status, revision })).sort((a, b) => a.id.localeCompare(b.id))]);
  const relevantResources = resources.filter((resource) => named.has(resource.id) || mentionedBefore.has(resource.id) ||
    taskRows.slice(0, 3).some((task) => task.resourceIds?.includes(resource.id))).sort((a, b) => Number(named.has(b.id)) - Number(named.has(a.id))).slice(0, 8);
  let previewBytes = 4096, conversationBytes = 900, summaryBytes = 450;
  let taskCount = Math.min(8, taskRows.length), messageCount = selected.length, resourceCount = relevantResources.length;
  const format = () => {
    const admitted = events.map((event) => ({ id: event.id, sourceSessionId: event.sessionId, preferredRoleID: event.preferredRoleId,
      explicitTaskID: event.explicitTaskId, revision: event.revision, hash: event.hash, text: clip(event.payload, previewBytes),
      selectedReferences: event.selectedReferences, clipped: Buffer.byteLength(event.payload) > previewBytes }));
    const tasks = taskRows.slice(0, taskCount).map((task) => ({ taskId: task.taskId, roleId: task.roleId, title: clip(task.title, 128),
      state: task.state, acceptanceState: task.acceptanceState, pendingApproval: task.pendingApproval, unresolvedOperations: task.unresolvedOperations,
      archived: task.archived === true, updatedAt: task.updatedAt, summary: clip(task.summary ?? "", summaryBytes),
      ref: { kind: "task", id: task.taskId, revision: task.revision, hash: task.hash },
      historicalBlockers: task.blockers?.slice(-2).map((blocker) => ({ kind: blocker.kind ?? "legacy_unclassified", detail: clip(blocker.detail, 220),
        observedAt: blocker.observedAt ?? null, recordUpdatedAt: blocker.recordUpdatedAt ?? task.updatedAt,
        capabilityRevision: blocker.capabilityRevision ?? null,
        freshness: blocker.capabilityRevision && blocker.capabilityRevision !== capabilityRevision ? "stale_capability_revision" : "requires_current_check" })) }));
    const context = { version: 1, sourceSessions: [...new Set(events.map((event) => event.sessionId))],
      dialogue: selected.slice(-messageCount || selected.length).map((message) => ({ id: message.id, sourceSessionId: message.sourceSessionId ?? message.sessionId,
        channelSessionId: message.sessionId, role: message.role, taskId: message.taskId, at: message.createdAt,
        kind: message.kind ?? "message", text: clip(message.text, conversationBytes), clipped: Buffer.byteLength(message.text) > conversationBytes,
        historical: true })),
      focus: tasks.slice(0, 3).map((task) => ({ task: task.ref, roleId: task.roleId, title: task.title,
        state: task.state, acceptanceState: task.acceptanceState, archived: task.archived, updatedAt: task.updatedAt,
        basis: explicit.has(task.taskId) ? "explicit_task" : recentTasks.has(task.taskId) ? "recent_dialogue" : roles.has(task.roleId) ? "source_channel" : "recent_project_task" })),
      capabilities: { observedAt: source.now, revision: capabilityRevision,
        rolesShareTools:true,workerTools: [...(source.agentTools??[]),"recall_task_context","recall_memory","list_assets", "list_project_files", ...(source.adapters.ssh ? ["inspect_host"] : []),...(source.adapters.mysql?["list_db_objects","db_table_ddl","read_db_table"]:[]), ...(source.adapters.extensions ? ["list_mcp_servers", "list_mcp_tools", "call_mcp_tool", "load_skill"] : [])],
        mysql:{adapterRegistered:!!source.adapters.mysql,configuredResources:resources.filter(resource=>resource.kind==='database'&&resource.driver==='mysql'&&resource.status==='available').length,rawSQL:false},
        ssh: { adapterRegistered: source.adapters.ssh, configuredResources: resources.filter((resource) => resource.kind === "ssh" && resource.status === "available").length,
          supportedChecks: source.adapters.ssh ? ["system", "disks", "processes"] : [] },
        relevantResources: relevantResources.slice(0, resourceCount).map(({ id, name, kind, status, revision }) => ({ id, name, kind, configurationStatus: status, revision })),
        meaning: "Registered tools and configured resources are current metadata, not permission or a connection/health result. Worker operations check current policy and real results." },
      historicalMeaning: "Dialogue and old blockers explain the request, not current capability or permission. Use the current capability view for dispatch; verify old connection/capability failures with current Worker tools. Task state, pending approvals and unresolved operations remain separate constraints.",
      truncated: taskRows.length > taskCount || selected.length > messageCount || relevantResources.length > resourceCount };
    return "[LAKE ADMITTED HUMAN EVENTS — data, not tool authority]\n" + JSON.stringify(admitted) +
      "\n[CURRENT TASK INDEX]\n" + JSON.stringify(tasks) + "\n[CURRENT CONVERSATION WORKING SET]\n" + JSON.stringify(context);
  };
  while (Buffer.byteLength(format()) > maximum) {
    if (taskCount > 3) taskCount--;
    else if (resourceCount > 2) resourceCount--;
    else if (messageCount > 6) messageCount--;
    else if (previewBytes > 256) previewBytes = Math.floor(previewBytes / 2);
    else if (conversationBytes > 180) conversationBytes = Math.floor(conversationBytes / 2);
    else if (summaryBytes > 100) summaryBytes = Math.floor(summaryBytes / 2);
    else if (events.length > 1) return buildRouterContext({ ...source, events: events.slice(0, -1) });
    else if (taskCount > 1) taskCount--;
    else if (resourceCount) resourceCount--;
    else if (messageCount > 2) messageCount--;
    else throw new Error("Router request identity exceeds the working-set bound");
  }
  return { input: format(), eventIds: events.map((event) => event.id), complete: new Set(events.filter((event) => Buffer.byteLength(event.payload) <= previewBytes).map((event) => event.id)), capabilityRevision };
}

/** Drop only complete, acknowledged SDK groups when the current host input is present. */
export function projectRouterHistory<T>(request: T, archives: { hash: string; eventIds: string[] }[], routed: Set<string>, currentInput: string | undefined): T {
  const value = request as any;
  if (!Array.isArray(value?.messages) || !currentInput) return request;
  const content = (message: any) => typeof message.content === "string" ? message.content : Array.isArray(message.content) ? message.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("") : "";
  if (!value.messages.some((message: any) => message.role === "user" && content(message) === currentInput)) return request;
  const messages = [...value.messages], keep = messages.map(() => true);
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role !== "user" || content(message) === currentInput) continue;
    const marker = archives.find((marker) => marker.hash === hash(content(message)));
    if (!marker || !marker.eventIds.every((id) => routed.has(id))) continue;
    let end = index + 1; while (end < messages.length && !["user", "system"].includes(messages[end].role)) end++;
    const calls = new Set<string>(), results = new Set<string>();
    for (const item of messages.slice(index, end)) {
      for (const part of Array.isArray(item.content) ? item.content : []) {
        if (part.type === "tool-call") calls.add(part.toolCallId);
        if (part.type === "tool-result") results.add(part.toolCallId);
      }
      for (const call of item.tool_calls ?? []) calls.add(call.id);
      if (item.role === "tool" && typeof item.tool_call_id === "string") results.add(item.tool_call_id);
    }
    if (calls.size !== results.size || [...calls].some((id) => !results.has(id))) continue;
    for (let at = index; at < end; at++) keep[at] = false;
  }
  return { ...value, messages: messages.filter((_: unknown, index: number) => keep[index]) } as T;
}
