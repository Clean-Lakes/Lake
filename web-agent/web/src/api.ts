import {displayAiError} from "./aiErrors";
import type { CommandPolicy } from "../../shared/command-policy";
import type {
  SSHConnectionInput,
  SSHKeyDirectory,
  AIImage,
  AIView,
  AIPreset,
  AvailableModels,
  Catalog,
  MessageQueue,
  QueueOperation,
  SendMessageResult,
  ModelSettings,
  ProviderCatalog,
  ProviderInput,
  ModelTestResult,
  Project,
  Resource,
  ResourceTreeNode,
  SessionSnapshot,
  ReasoningSettings,
  TerminalHistory,
  TerminalSession,
  ResourceImportPreview,
  TextFileAttachment,
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
  terminalMode: "command" | "pty";
  supportsImageInput?: boolean;
  aiRuntime?: "go" | "legacy";
};

export const api = {
 commandPolicy: (command:string) => post<CommandPolicy>("/api/commands/policy",{command}),
  bootstrap: (token?: string) =>
    request<Bootstrap>("/api/bootstrap", token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
  catalog: (signal?: AbortSignal) => request<Catalog>("/api/catalog", { signal }),
  modelCapacity: () => request<{modelId?: string; limit: number; source?: string}>("/api/settings/model/capacity"),
  providers: () => request<ProviderCatalog>("/api/settings/providers"),
  saveProvider: (id: string | null, data: ProviderInput) => request<ProviderCatalog>(`/api/settings/providers${id ? "/" + encodeURIComponent(id) : ""}`, {method: id ? "PUT" : "POST", body: JSON.stringify(data)}),
  deleteProvider: (id: string) => request<ProviderCatalog>(`/api/settings/providers/${encodeURIComponent(id)}`, {method:"DELETE"}),
  selectProviderModel: (providerId: string, modelId: string) => post<ProviderCatalog>("/api/settings/model/select", {providerId, modelId}),
  testProvider: (id: string, data: {baseURL: string; protocol: string; model: string; apiKey?: string | null}) => post<ModelTestResult>(`/api/settings/providers/${encodeURIComponent(id)}/test`, data),
  discoverProvider: (id: string, data: {baseURL: string; protocol: string; apiKey?: string | null}) => post<AvailableModels>(`/api/settings/providers/${encodeURIComponent(id)}/discover`, data),
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
  createProject: (name: string) => post<Project>("/api/projects", { name }),
  editResourceTree: (project: string, data: {operation: "create" | "rename" | "move" | "delete"; nodeId?: string; parentId?: string | null; beforeId?: string | null; name?: string}) => post<{nodes: ResourceTreeNode[]}>(`/api/projects/${encodeURIComponent(project)}/resource-tree`, data),
  sshKeys: (directory = "~/.ssh") => post<SSHKeyDirectory>("/api/settings/ssh/keys", {directory}),
  createSshResource: (projectId: string, name: string, ssh: SSHConnectionInput) =>
    post<Resource>(`/api/projects/${encodeURIComponent(projectId)}/resources`, { kind: "ssh", name, ssh }),
  createServiceResource: (projectId: string, name: string, kind: string, settings: object) => post<Resource>(`/api/projects/${encodeURIComponent(projectId)}/resources`, { name, kind, settings }),
  previewResourceImport: (projectId: string, name: string, text: string) => post<ResourceImportPreview>(`/api/projects/${encodeURIComponent(projectId)}/resource-import-preview`, {name, text}),
  importResources: (projectId: string, planId: string, indexes: number[]) => post<{createdCount: number; skippedCount: number}>(`/api/projects/${encodeURIComponent(projectId)}/resource-import`, {planId, indexes}),
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
  deleteSession: (sessionId: string) =>
    request<void>(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" }),
  sendMessage: (sessionId: string, text: string, resourceIds: string[] = [], images: AIImage[] = [], references: Record<string, unknown>[] = [], terminalReuse?: {terminalId: string; generation: string}, files: TextFileAttachment[] = [], enqueue = false) =>
    post<SendMessageResult>(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, { text, ...(enqueue ? {enqueue:true} : {}), ...(files.length ? {files} : {}), ...(terminalReuse ? {terminalReuse} : {}), ...(references.length ? { references } : {}), ...(images.length ? { images } : {}), ...(resourceIds.length ? { resourceIds } : {}) }),
  messageQueue: (sessionId: string) => request<MessageQueue>(`/api/sessions/${encodeURIComponent(sessionId)}/message-queue`),
  updateMessageQueue: (sessionId: string, data: QueueOperation) => post<MessageQueue>(`/api/sessions/${encodeURIComponent(sessionId)}/message-queue`, data),
  decide: (actionId: string, decision: "approve" | "reject", confirmation?: string) =>
    post<unknown>(`/api/actions/${encodeURIComponent(actionId)}/decision`, { decision, confirmation }),
  createTerminal: (sessionId: string, resourceId: string, shell?: string, interactive = false) =>
    post<TerminalSession>(`/api/sessions/${encodeURIComponent(sessionId)}/terminals`, { resourceId, ...(shell ? {shell} : {}), ...(interactive ? {interactive: true} : {}) }),
  resourceTerminalContext: (resourceId: string) => post<{sessionId: string}>(`/api/resources/${encodeURIComponent(resourceId)}/terminal-context`, {}),
  resourceTerminals: (resourceId: string) => request<{terminals: TerminalSession[]}>(`/api/resources/${encodeURIComponent(resourceId)}/terminals`),
  availableTerminals: (session: string) => request<Array<TerminalSession & {ownerTitle:string}>>(`/api/sessions/${encodeURIComponent(session)}/terminals/available`),
  terminalAIScope: (session: string, terminal: string, generation: string) => post<{sessionId:string;terminalId:string;generation:string;needsAdoption:boolean;shellRecreated:boolean;ownerTitle:string}>(`/api/sessions/${encodeURIComponent(session)}/terminals/${encodeURIComponent(terminal)}/ai-scope`,{generation}),
  adoptTerminal: (session: string, terminal: string, generation: string, bind=false) => post<TerminalSession>(`/api/sessions/${encodeURIComponent(session)}/terminals/${encodeURIComponent(terminal)}/adopt`,{accept:true,generation,bind}),
  referenceMemory: (session: string) => request<string[]>(`/api/sessions/${encodeURIComponent(session)}/ai/references`),
  hostKeyDecision: (sessionId: string, decision: {id: string; accept: boolean; fingerprint: string; confirmation: string}) =>
    post<unknown>(`/api/sessions/${encodeURIComponent(sessionId)}/host-key`, decision),
  closeResourceTerminal: (resourceId: string, terminalId?: string) => request<{closed: number}>(`/api/resources/${encodeURIComponent(resourceId)}/terminals${terminalId ? `/${encodeURIComponent(terminalId)}` : ""}`, { method: "DELETE" }),
  terminalHistory: (sessionId: string, terminalId: string, signal?: AbortSignal) =>
    request<TerminalHistory>(
      `/api/sessions/${encodeURIComponent(sessionId)}/terminals/${encodeURIComponent(terminalId)}/history`,
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
