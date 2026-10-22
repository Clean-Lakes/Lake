import type {MCPServerConfig,MCPToolCatalog,SkillConfig,SkillCatalog} from "../../shared/contracts";
import {displayAiError} from "./aiErrors";
import type { CommandPolicy } from "../../shared/command-policy";
import type { WorkspaceTag } from "../../shared/contracts";
import type {
  SSHConnectionInput,
  SSHKeyDirectory,
  AIImage,
  AIView,
  AIPreset,
  AvailableModels,
  AvailableModelEntry,
  Catalog,
  WorkflowCatalog,
  WorkflowInput,
  WorkflowTemplate,
  WorkflowRun,
  MessageQueue,
  QueueOperation,
  SendMessageResult,
  NavigationTrashItem,
  ModelSettings,
  ProviderCatalog,
  ProviderInput,
  ModelTestResult,
  Project,
  ProjectMemoryEntry,
  ProjectMemoryJob,
  ProjectMemoryList,
  ProjectMemorySettings,
  Resource,
  ResourceTreeNode,
  SessionSnapshot,
  ReasoningSettings,
  TerminalHistory,
  TerminalSession,
  ResourceImportPreview,
  TextFileAttachment,
  MessageMention,
  WorkSession,
} from "../../shared/contracts";

export class ApiRequestError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "ApiRequestError";
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
  } catch {
    throw new ApiRequestError("无法连接到 Lake 服务。请确认服务正在运行，然后重试。", 0);
  }

  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: unknown } | null;
    const detail = typeof body?.error === "string" ? body.error : null;
    throw new ApiRequestError(detail || `请求失败（HTTP ${response.status}）。请重试。`, response.status);
  }

  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function post<T>(path: string, body: object): Promise<T> {
  return request<T>(path, { method: "POST", body: JSON.stringify(body) });
}

export type Bootstrap = {
  authenticated: boolean;
  modelConfigured: boolean;
  modelName: string | null;
  modelId?: string | null;
  modelSelection?: AvailableModelEntry | null;
  terminalMode: "command" | "pty";
  supportsImageInput?: boolean;
  aiRuntime?: "go" | "legacy";
};

export type ModelSyncState = Pick<Bootstrap,"modelConfigured"|"modelName"|"modelId"|"modelSelection"|"supportsImageInput"> & {
  available: AvailableModels | null;
  providers: ProviderCatalog;
  settings: ModelSettings;
};

export const api = {
 plans:(session:string)=>request<{plans:import('../../shared/contracts').ProposedPlan[]}>(`/api/sessions/${encodeURIComponent(session)}/ai/plans`),
 setConversationMode:(session:string,mode:import('../../shared/contracts').ConversationMode)=>post<import('../../shared/contracts').ConversationModeUpdate>(`/api/sessions/${encodeURIComponent(session)}/ai/mode`,{mode}),
 executePlan:(session:string,planId:string)=>post<SendMessageResult>(`/api/sessions/${encodeURIComponent(session)}/ai/executePlan`,{planId}),
 progressSummary:(session:string,turnStartedAt:string)=>post<{text:string;pending:boolean}>(`/api/sessions/${encodeURIComponent(session)}/ai/progress-summary`,{turnStartedAt}),
 schedules:(project:string,signal?:AbortSignal)=>request<{items:import('../../shared/contracts').ScheduledTask[]}>(`/api/projects/${encodeURIComponent(project)}/schedules`,{signal}),
 schedule:(project:string,id:string,signal?:AbortSignal)=>request<import('../../shared/contracts').ScheduledTask>(`/api/projects/${encodeURIComponent(project)}/schedules/${encodeURIComponent(id)}`,{signal}),
 setScheduleEnabled:(project:string,id:string,enabled:boolean,expectedRevision:number)=>request<import('../../shared/contracts').ScheduledTask>(`/api/projects/${encodeURIComponent(project)}/schedules/${encodeURIComponent(id)}`,{method:'PATCH',body:JSON.stringify({enabled,expectedRevision})}),
	getSREEnabled:(project:string,signal?:AbortSignal)=>request<{enabled:boolean}>(`/api/projects/${encodeURIComponent(project)}/sre`,{signal}),
	setSREEnabled:(project:string,enabled:boolean)=>request<{enabled:boolean}>(`/api/projects/${encodeURIComponent(project)}/sre`,{method:'PUT',body:JSON.stringify({enabled})}),
	sreTask:(session:string,task:string)=>request<import('../../shared/contracts').SRETask>(`/api/sessions/${encodeURIComponent(session)}/sre/tasks/${encodeURIComponent(task)}`),
	sreTasks:(session:string,cursor='')=>request<{items:import('../../shared/contracts').SRETask[];nextCursor:string}>(`/api/sessions/${encodeURIComponent(session)}/sre/tasks?limit=20&cursor=${encodeURIComponent(cursor)}`),
	sreEvents:(session:string,task:string,after=0)=>request<{items:Array<{id:number;type:string;createdAt:string;payload:Record<string,unknown>}>}>(`/api/sessions/${encodeURIComponent(session)}/sre/tasks/${encodeURIComponent(task)}/events?after=${after}`),
	sreOperation:(session:string,task:string,operation:string,data:Record<string,unknown>)=>post<import('../../shared/contracts').SRETask>(`/api/sessions/${encodeURIComponent(session)}/sre/tasks/${encodeURIComponent(task)}/${operation}`,data),
	sreEvidence:(session:string,task:string,evidence:string,offset=0)=>request<{source:string;nextCursor:number|null;sourceTruncated:boolean;sourceBytes:number;collectedAt:string}>(`/api/sessions/${encodeURIComponent(session)}/sre/tasks/${encodeURIComponent(task)}/evidence/${encodeURIComponent(evidence)}?offset=${offset}`),
	sreExport:(session:string,task:string)=>request<{name:string;content:string}>(`/api/sessions/${encodeURIComponent(session)}/sre/tasks/${encodeURIComponent(task)}/export`),
  mcpServers:()=>request<{servers:MCPServerConfig[]}>("/api/settings/mcp"),
  importMCP:(value:unknown)=>request<{servers:MCPServerConfig[]}>("/api/settings/mcp/import",{method:"POST",body:JSON.stringify(value)}),
  saveMCP:(value:Record<string,unknown>)=>request<MCPServerConfig>(`/api/settings/mcp${value.id?`/${encodeURIComponent(String(value.id))}`:""}`,{method:value.id?"PUT":"POST",body:JSON.stringify(value)}),
  deleteMCP:(id:string)=>request(`/api/settings/mcp/${encodeURIComponent(id)}`,{method:"DELETE"}),
  testMCP:(id:string)=>request<MCPToolCatalog>(`/api/settings/mcp/${encodeURIComponent(id)}/test`,{method:"POST",body:"{}"}),
  skills:()=>request<SkillCatalog>("/api/settings/skills"),
  skill:(name:string)=>request<{skill:SkillConfig;content:string}>(`/api/settings/skills/${encodeURIComponent(name)}`),
  saveSkill:(name:string,value:{content?:string;enabled?:boolean;create?:boolean})=>request(`/api/settings/skills/${encodeURIComponent(name)}`,{method:"PUT",body:JSON.stringify(value)}),
  skillRoot:(path:string,remove=false)=>request("/api/settings/skills/roots",{method:remove?"DELETE":"POST",body:JSON.stringify({path})}),
  createTag: (project:string,data:{name:string;color:string}) => post<WorkspaceTag>(`/api/projects/${encodeURIComponent(project)}/tags`,data),
  updateTag: (id:string,data:{name:string;color:string}) => request<WorkspaceTag>(`/api/tags/${encodeURIComponent(id)}`,{method:"PUT",body:JSON.stringify(data)}),
  deleteTag: (id:string) => request(`/api/tags/${encodeURIComponent(id)}`,{method:"DELETE"}),
  saveSessionPresentation: (session:WorkSession,icon:string,tagIds:string[]) => request<WorkSession>(`/api/sessions/${encodeURIComponent(session.id)}/presentation`,{method:"PUT",body:JSON.stringify({icon,tagIds,revision:session.presentationRevision??0})}),
 commandPolicy: (command:string) => post<CommandPolicy>("/api/commands/policy",{command}),
  bootstrap: (token?: string) =>
    request<Bootstrap>("/api/bootstrap", token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
  workflows: (project:string, signal?:AbortSignal) => request<WorkflowCatalog>(`/api/projects/${encodeURIComponent(project)}/workflows`, {signal}),
  saveWorkflow: (project:string, data:WorkflowInput, id?:string) => id ? request<WorkflowTemplate>(`/api/projects/${encodeURIComponent(project)}/workflows/${encodeURIComponent(id)}`, {method:"PUT", headers:{"Content-Type":"application/json"},body:JSON.stringify(data)}) : post<WorkflowTemplate>(`/api/projects/${encodeURIComponent(project)}/workflows`,data),
  deleteWorkflow: (project:string,id:string,version:number) => request(`/api/projects/${encodeURIComponent(project)}/workflows/${encodeURIComponent(id)}`,{method:"DELETE",headers:{"Content-Type":"application/json"},body:JSON.stringify({version})}),
  runWorkflow: (project:string,id:string,version:number) => post<WorkflowRun>(`/api/projects/${encodeURIComponent(project)}/workflows/${encodeURIComponent(id)}/run`,{version}),
  cancelWorkflow: (project:string,id:string) => post(`/api/projects/${encodeURIComponent(project)}/workflow-runs/${encodeURIComponent(id)}/cancel`,{}),
  navigationTrash: () => request<{items:NavigationTrashItem[]}>("/api/navigation-trash"),
  deleteNavigation: (kind:"project" | "resource",id:string) => post<{items:NavigationTrashItem[]}>("/api/navigation-delete",{kind,id}),
  restoreNavigation: (kind:NavigationTrashItem["kind"],id:string) => post<{items:NavigationTrashItem[]}>("/api/navigation-trash",{kind,id}),
  completeDraft: (session:string,text:string,modelId:string|undefined,signal:AbortSignal) => request<{suffix:string;modelId?:string}>(`/api/sessions/${encodeURIComponent(session)}/completion`,{method:"POST",body:JSON.stringify({text,modelId}),signal}),
  catalog: (signal?: AbortSignal) => request<Catalog>("/api/catalog", { signal }),
  modelCapacity: () => request<{modelId?: string; limit: number; source?: string}>("/api/settings/model/capacity"),
  providers: () => request<ProviderCatalog>("/api/settings/providers"),
  saveProvider: (id: string | null, data: ProviderInput) => request<ProviderCatalog>(`/api/settings/providers${id ? "/" + encodeURIComponent(id) : ""}`, {method: id ? "PUT" : "POST", body: JSON.stringify(data)}),
  deleteProvider: (id: string) => request<ProviderCatalog>(`/api/settings/providers/${encodeURIComponent(id)}`, {method:"DELETE"}),
  selectProviderModel: (providerId: string, modelId: string) => post<ProviderCatalog>("/api/settings/model/select", {providerId, modelId}),
  testProvider: (id: string, data: {baseURL: string; protocol: string; model: string; apiKey?: string | null}) => post<ModelTestResult>(`/api/settings/providers/${encodeURIComponent(id)}/test`, data),
  discoverProvider: (id: string, data: {baseURL: string; protocol: string; apiKey?: string | null}) => post<AvailableModels>(`/api/settings/providers/${encodeURIComponent(id)}/discover`, data),
  detectProviderCapabilities: (id: string) => post<{status:string;total:number;complete:number}>(`/api/settings/providers/${encodeURIComponent(id)}/detect-capabilities`, {}),
  providerCapabilityStatus: (id: string) => request<{status:string;total:number;complete:number}>(`/api/settings/providers/${encodeURIComponent(id)}/detect-capabilities`),
  modelSettings: (signal?: AbortSignal) => request<ModelSettings>("/api/settings/model", { signal }),
  saveModelSettings: (url: string, name: string, apiKey?: string, protocol = "openai", supportsImageInput?: boolean, supportsImageOutput?: boolean) =>
    request<ModelSettings>("/api/settings/model", {
      method: "PUT",
      body: JSON.stringify({ url, name, protocol, ...(supportsImageInput === undefined ? {} : { supportsImageInput }), ...(supportsImageOutput === undefined ? {} : { supportsImageOutput }), ...(apiKey === undefined ? {} : { apiKey }) }),
    }),
  clearModelSettings: () => request<ModelSettings>("/api/settings/model", { method: "DELETE" }),
  testModelSettings: (url: string, name: string, apiKey?: string, protocol = "openai", supportsImageInput?: boolean, supportsImageOutput?: boolean) =>
    request<ModelTestResult>("/api/settings/model/test", {
      method: "POST",
      body: JSON.stringify({ url, name, protocol, ...(supportsImageInput === undefined ? {} : { supportsImageInput }), ...(supportsImageOutput === undefined ? {} : { supportsImageOutput }), ...(apiKey === undefined ? {} : { apiKey }) }),
    }),
  availableModels: (signal?: AbortSignal) => request<AvailableModels>("/api/settings/model/available", { signal }),
  modelState: (signal?: AbortSignal) => request<ModelSyncState>("/api/settings/model/state", { signal }),
  createProject: (name: string) => post<Project>("/api/projects", { name }),
  projectMemories: (projectId: string, query = "", includeExpired = false, includeDeleted = false, offset = 0, signal?: AbortSignal) => request<ProjectMemoryList>(`/api/projects/${encodeURIComponent(projectId)}/memory?query=${encodeURIComponent(query)}&includeExpired=${includeExpired}&includeDeleted=${includeDeleted}&offset=${offset}&limit=50`, {signal}),
  projectMemory: (projectId: string, key: string, includeDeleted = false, signal?: AbortSignal) => request<ProjectMemoryEntry>(`/api/projects/${encodeURIComponent(projectId)}/memory/${encodeURIComponent(key)}${includeDeleted ? "?includeDeleted=true" : ""}`, {signal}),
  saveProjectMemory: (projectId: string, key: string, data: {type: ProjectMemoryEntry["type"]; description: string; body: string; expectedRevision: number; validUntil?: string; restoreDeleted?: boolean}) => request<{revision:number}>(`/api/projects/${encodeURIComponent(projectId)}/memory/${encodeURIComponent(key)}`, {method:"PUT", body:JSON.stringify(data)}),
  forgetProjectMemory: (projectId: string, key: string, expectedRevision: number) => request(`/api/projects/${encodeURIComponent(projectId)}/memory/${encodeURIComponent(key)}`, {method:"DELETE", body:JSON.stringify({expectedRevision})}),
  projectMemorySettings: (projectId: string) => request<ProjectMemorySettings>(`/api/projects/${encodeURIComponent(projectId)}/memory-settings`),
  setProjectMemorySettings: (projectId: string, useEnabled: boolean, extractionEnabled: boolean, expectedRevision: number) => request<ProjectMemorySettings>(`/api/projects/${encodeURIComponent(projectId)}/memory-settings`, {method:"PATCH", body:JSON.stringify({useEnabled,extractionEnabled,expectedRevision})}),
  projectMemoryJobs: (projectId: string) => request<{items:ProjectMemoryJob[]}>(`/api/projects/${encodeURIComponent(projectId)}/memory-jobs`),
  retryProjectMemoryJob: (projectId: string, jobId: string, expectedProjectRevision: number) => post<{jobId:string;status:string}>(`/api/projects/${encodeURIComponent(projectId)}/memory-jobs/${encodeURIComponent(jobId)}/retry`, {expectedProjectRevision}),
  editResourceTree: (project: string, data: {operation: "create" | "rename" | "move" | "delete"; nodeId?: string; parentId?: string | null; beforeId?: string | null; name?: string}) => post<{nodes: ResourceTreeNode[]}>(`/api/projects/${encodeURIComponent(project)}/resource-tree`, data),
  sshKeys: (directory = "~/.ssh") => post<SSHKeyDirectory>("/api/settings/ssh/keys", {directory}),
  createSshResource: (projectId: string, name: string, ssh: SSHConnectionInput, parentId?: string | null) =>
    post<Resource>(`/api/projects/${encodeURIComponent(projectId)}/resources`, { kind: "ssh", name, ssh, ...(parentId ? { parentId } : {}) }),
  editTerminalResource: (id: string, data: {name: string; ssh?: SSHConnectionInput; settings?: {shell: string}}) => request<Resource>(`/api/resources/${encodeURIComponent(id)}`, {method: "PATCH", body: JSON.stringify(data)}),
  createServiceResource: (projectId: string, name: string, kind: string, settings: object, parentId?: string | null) => post<Resource>(`/api/projects/${encodeURIComponent(projectId)}/resources`, { name, kind, settings, ...(parentId ? { parentId } : {}) }),
  previewResourceImport: (projectId: string, name: string, text: string) => post<ResourceImportPreview>(`/api/projects/${encodeURIComponent(projectId)}/resource-import-preview`, {name, text}),
  previewHexhubImport: (projectId: string) => post<ResourceImportPreview>(`/api/projects/${encodeURIComponent(projectId)}/resource-import-preview`, {hexhub: true}),
  importResources: (projectId: string, planId: string, indexes: number[]) => post<{createdCount: number; skippedCount: number; updatedCount: number}>(`/api/projects/${encodeURIComponent(projectId)}/resource-import`, {planId, indexes}),
  uploadAttachment: (sessionId: string, file: File) => request<TextFileAttachment>(`/api/sessions/${encodeURIComponent(sessionId)}/attachments`, {method:"POST",body:file,headers:{"Content-Type":"application/octet-stream","X-Lake-Filename":encodeURIComponent(file.name)}}),
  uploadTextFile: (sessionId: string, name: string, text: string) => post<TextFileAttachment>(`/api/sessions/${encodeURIComponent(sessionId)}/text-files`, {name, text}),
  aiCards: (session: string, before: number) => request<AIView>(`/api/sessions/${encodeURIComponent(session)}/ai/snapshot?before=${before}`),
  aiView: (session: string) => request<AIView>(`/api/sessions/${encodeURIComponent(session)}/ai`),
  aiOptions: (session: string) => request<Record<string, unknown>>(`/api/sessions/${encodeURIComponent(session)}/ai/options`),
  reasoning: (session: string) => request<ReasoningSettings>(`/api/sessions/${encodeURIComponent(session)}/ai/reasoning`),
  setReasoning: (session: string, modelId: string, effort: string) => post<ReasoningSettings>(`/api/sessions/${encodeURIComponent(session)}/ai/reasoning`, { modelId, effort }),
  aiOperation: <T = unknown>(session: string, operation: string, data: object = {}) => post<T>(`/api/sessions/${encodeURIComponent(session)}/ai/${operation}`, data),
  aiPresets: () => request<AIPreset[]>("/api/ai/presets"),
  saveAIPreset: (preset: { id?: string; title: string; content: string }) => post<unknown>("/api/ai/presets", preset),
  deleteAIPreset: (id: string) => request<unknown>("/api/ai/presets", { method: "DELETE", body: JSON.stringify({ id }) }),
  createSession: (projectId: string, terminalReuse?: {terminalId: string; generation: string}) =>
    post<WorkSession>(`/api/projects/${encodeURIComponent(projectId)}/sessions`, terminalReuse ? {terminalReuse} : {}),
  snapshot: (sessionId: string, signal?: AbortSignal) =>
    request<SessionSnapshot>(`/api/sessions/${encodeURIComponent(sessionId)}/snapshot`, { signal }),
  renameSession: (sessionId: string, title: string) => request<WorkSession>(`/api/sessions/${encodeURIComponent(sessionId)}`, {method: "PATCH", body: JSON.stringify({title})}),
  deleteSession: (sessionId: string) =>
    request<void>(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" }),
  sendMessage: (sessionId: string, text: string, resourceIds: string[] = [], images: AIImage[] = [], references: Record<string, unknown>[] = [], terminalReuse?: {terminalId: string; generation: string}, files: TextFileAttachment[] = [], enqueue = false, ignoreProjectMemory = false, mentions: MessageMention[] = []) =>
    post<SendMessageResult>(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, { text, mentions, ...(ignoreProjectMemory ? {ignoreProjectMemory:true} : {}), ...(enqueue ? {enqueue:true} : {}), ...(files.length ? {files} : {}), ...(terminalReuse ? {terminalReuse} : {}), ...(references.length ? { references } : {}), ...(images.length ? { images } : {}), ...(resourceIds.length ? { resourceIds } : {}) }),
  messageQueue: (sessionId: string) => request<MessageQueue>(`/api/sessions/${encodeURIComponent(sessionId)}/message-queue`),
  updateMessageQueue: (sessionId: string, data: QueueOperation) => post<MessageQueue>(`/api/sessions/${encodeURIComponent(sessionId)}/message-queue`, data),
  decide: (actionId: string, decision: "approve" | "reject", confirmation?: string) =>
    post<unknown>(`/api/actions/${encodeURIComponent(actionId)}/decision`, { decision, confirmation }),
  createTerminal: (sessionId: string, resourceId: string, shell?: string, interactive = false) =>
    post<TerminalSession>(`/api/sessions/${encodeURIComponent(sessionId)}/terminals`, { resourceId, ...(shell ? {shell} : {}), ...(interactive ? {interactive: true} : {}) }),
  resourceTerminalContext: (resourceId: string) => post<{sessionId: string}>(`/api/resources/${encodeURIComponent(resourceId)}/terminal-context`, {}),
  resourceTerminals: (resourceId: string, signal?: AbortSignal) => request<{terminals: TerminalSession[]}>(`/api/resources/${encodeURIComponent(resourceId)}/terminals`, {signal}),
  availableTerminals: (session: string) => request<Array<TerminalSession & {ownerTitle:string}>>(`/api/sessions/${encodeURIComponent(session)}/terminals/available`),
  terminalAIScope: (session: string, terminal: string, generation: string) => post<{sessionId:string;terminalId:string;generation:string;needsAdoption:boolean;shellRecreated:boolean;ownerTitle:string}>(`/api/sessions/${encodeURIComponent(session)}/terminals/${encodeURIComponent(terminal)}/ai-scope`,{generation}),
  adoptTerminal: (session: string, terminal: string, generation: string, bind=false) => post<TerminalSession>(`/api/sessions/${encodeURIComponent(session)}/terminals/${encodeURIComponent(terminal)}/adopt`,{accept:true,generation,bind}),
  referenceMemory: (session: string) => request<string[]>(`/api/sessions/${encodeURIComponent(session)}/ai/references`),
  hostKeyDecision: (sessionId: string, decision: {id: string; accept: boolean; fingerprint: string}) =>
    post<unknown>(`/api/sessions/${encodeURIComponent(sessionId)}/host-key`, decision),
  closeResourceTerminal: (resourceId: string, terminalId?: string) => request<{closed: number}>(`/api/resources/${encodeURIComponent(resourceId)}/terminals${terminalId ? `/${encodeURIComponent(terminalId)}` : ""}`, { method: "DELETE" }),
  terminalHistory: (sessionId: string, terminalId: string, signal?: AbortSignal, outputOnly = false) =>
    request<TerminalHistory>(
      `/api/sessions/${encodeURIComponent(sessionId)}/terminals/${encodeURIComponent(terminalId)}/history${outputOnly ? "?outputOnly=1" : ""}`,
      { signal },
    ),
  terminalControl: (sessionId: string, terminalId: string, holder: "user" | "agent" | null) =>
    post<unknown>(
      `/api/sessions/${encodeURIComponent(sessionId)}/terminals/${encodeURIComponent(terminalId)}/control`,
      { holder },
    ),
  terminalCommand: (sessionId: string, terminalId: string, command: string, confirmed = false, confirmation?: string) =>
    post<unknown>(
      `/api/sessions/${encodeURIComponent(sessionId)}/terminals/${encodeURIComponent(terminalId)}/commands`,
      { command, actor: "user", confirmed, confirmation },
    ),
  terminalInterrupt: (sessionId: string, terminalId: string) =>
    post<unknown>(
      `/api/sessions/${encodeURIComponent(sessionId)}/terminals/${encodeURIComponent(terminalId)}/interrupt`,
      {},
    ),
  terminalInput: (sessionId: string, terminalId: string, data: string) =>
    post<unknown>(`/api/sessions/${encodeURIComponent(sessionId)}/terminals/${encodeURIComponent(terminalId)}/input`, { data }),
  terminalResize: (sessionId: string, terminalId: string, cols: number, rows: number) =>
    post<unknown>(`/api/sessions/${encodeURIComponent(sessionId)}/terminals/${encodeURIComponent(terminalId)}/resize`, { cols, rows }),
  terminalDisconnect: (sessionId: string, terminalId: string) =>
    post<unknown>(`/api/sessions/${encodeURIComponent(sessionId)}/terminals/${encodeURIComponent(terminalId)}/disconnect`, {}),
  eventsUrl: (sessionId: string, cursor: number) =>
    `/api/sessions/${encodeURIComponent(sessionId)}/events?after=${encodeURIComponent(String(cursor))}`,
};

export function readableError(error: unknown): string {
  return error instanceof Error ? displayAiError(error.message) : "请求未完成。请重试。";
}
