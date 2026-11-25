import type { ToolEntry } from '../sdk';

import type {CodexProjectOverrides,ExternalAgentId,ExternalAgentStatus as PublicAgentStatus,ExternalRuntimeKind,StoredExternalAgentId} from '../../../web-agent/shared/external-agents';
export type {ExternalAgentId,AgentBackendRef} from '../../../web-agent/shared/external-agents';
export type ExternalAgentProfile = CodexProjectOverrides & {
  schemaVersion: 3; runtimeKind:ExternalRuntimeKind;
  id: ExternalAgentId; projectId: string; revision: number; enabled: boolean;
  nodePath?: string; npmPath?:string; authentication:'codex-local';sourceFingerprint:string;updatedAt: string;
};
export type ExternalAgentStatus = ExternalAgentProfile & PublicAgentStatus & {
  capabilities?: Record<string, unknown>;
};
export type CodexModelOption = {
  id: string;
  reasoningEfforts: string[];
  defaultReasoningEffort?: string;
};
export const codexConnectionVersion = 2;
export type CodexConnectionProbe = {
  connectionVersion?: 1 | typeof codexConnectionVersion;
  revision: number;
  authentication?: string;
  ready: boolean;
  authenticated?: boolean;
  model?: string;
  localModel?: string;
  models?: CodexModelOption[];
  modelProvider?: string;
  reasoningEffort?: string;
  authMode?: ExternalAgentStatus['authMode'];
  capabilities?: Record<string, unknown>;
  message?: string;
};
export type ExternalRunState = 'starting' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'unknown';
export type ExternalRun = {
  schemaVersion: 1;
  runtimeKind?:ExternalRuntimeKind;
  id: string; agent: StoredExternalAgentId; profileRevision: number; projectId: string;
  purpose?:'worker'|'child'|'segment'|'conversation';
  requestedModel?:string;model?:string;modelProvider?:string;reasoningEffort?:string;
  taskId?: string; conversationId?:string; workerId: string; sessionId: string; childSessionId?: string; agentRunId?: string; rootTurnId?:string;
  generation: number; scopeHash: string; contextId: string; requestKey: string; inputHash: string; state: ExternalRunState;
  dispatchPhase: 'not_sent' | 'dispatching' | 'sent' | 'answered';
  externalSessionId?: string; createdAt: string; updatedAt: string;
  stopReason?: string; summary?: string; error?: string; events: ExternalEvent[];
  usage: {inputTokens:number;outputTokens:number} | null;
};
export type ExternalEvent = {
  sequence: number; kind: 'text' | 'tool' | 'tool_update' | 'status'; text?: string;
  /** Read-only current ACP message projection; text remains the full run audit. */
  publicText?: string; publicTextId?: string;
  callId?: string; title?: string; status?: string; at: string;
};
/** Constructed by Lake's current task or conversation host. Never deserialized from tool arguments. */
export type ExternalActor = {
  projectId: string; taskId?: string; conversationId?:string; workerId: string; sessionId: string;
  childSessionId?: string; agentRunId?: string; generation: number; rootTurnId?:string;
  readonly deadlineAt: string; scopeHash: string; workspace: string; signal: AbortSignal;
  purpose?: 'worker' | 'child' | 'segment' | 'conversation';
  systemPrompt?: string;
  model?:string;
  guard: () => void; tools: ToolEntry[];
  executeTool: (name: string, input: unknown, callId: string, signal: AbortSignal) => Promise<unknown>;
  event: (run: ExternalRun, event: ExternalEvent) => void;
  inputConsumed?: (inputId:string) => void;
};
export type ExternalResult = {
  run_id: string; agent: string; state: ExternalRunState; summary: string;
  stop_reason?: 'deadline_reached';
  public_reply?: {id:string;content:string};
  verification: 'insufficient'; limitations: string[];
};
export const maxExternalConversationRuns = 16;
