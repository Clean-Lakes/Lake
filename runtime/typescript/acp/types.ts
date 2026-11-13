import type { ToolEntry } from '../sdk';

import type {ExternalAgentId,StoredExternalAgentId} from '../../../web-agent/shared/external-agents';
export type {ExternalAgentId,AgentBackendRef} from '../../../web-agent/shared/external-agents';
export type ExternalAgentProfile = {
  schemaVersion: 2;
  id: ExternalAgentId; projectId: string; revision: number; enabled: boolean;
  nodePath?: string; npmPath?:string; authentication:'codex-local';sourceFingerprint:string;updatedAt: string;
};
export type ExternalAgentStatus = ExternalAgentProfile & {
  name: string; installed: boolean; transportReady: boolean; message?: string;
  assignmentReady?:boolean;assignmentBlocker?:string;
  capabilities?: Record<string, unknown>;
  model?:string;modelProvider?:string;reasoningEffort?:string;configPath?:string;authMode?:'chatgpt'|'api_key'|'provider'|'none';
};
export type ExternalRunState = 'starting' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'unknown';
export type ExternalRun = {
  schemaVersion: 1;
  id: string; agent: StoredExternalAgentId; profileRevision: number; projectId: string;
  purpose?:'worker'|'child'|'segment'|'conversation';
  requestedModel?:string;model?:string;modelProvider?:string;reasoningEffort?:string;
  taskId?: string; conversationId?:string; workerId: string; sessionId: string; childSessionId?: string; agentRunId?: string;
  generation: number; scopeHash: string; contextId: string; requestKey: string; inputHash: string; state: ExternalRunState;
  dispatchPhase: 'not_sent' | 'dispatching' | 'sent' | 'answered';
  externalSessionId?: string; createdAt: string; updatedAt: string;
  stopReason?: string; summary?: string; error?: string; events: ExternalEvent[];
  usage: {inputTokens:number;outputTokens:number} | null;
};
export type ExternalEvent = {
  sequence: number; kind: 'text' | 'tool' | 'tool_update' | 'status'; text?: string;
  callId?: string; title?: string; status?: string; at: string;
};
/** Constructed by Lake's current task or conversation host. Never deserialized from tool arguments. */
export type ExternalActor = {
  projectId: string; taskId?: string; conversationId?:string; workerId: string; sessionId: string;
  childSessionId?: string; agentRunId?: string; generation: number;
  deadlineAt: string; scopeHash: string; workspace: string; signal: AbortSignal;
  purpose?: 'worker' | 'child' | 'segment' | 'conversation';
  systemPrompt?: string;
  model?:string;
  guard: () => void; tools: ToolEntry[];
  executeTool: (name: string, input: unknown, callId: string, signal: AbortSignal) => Promise<unknown>;
  event: (run: ExternalRun, event: ExternalEvent) => void;
};
export type ExternalResult = {
  run_id: string; agent: string; state: ExternalRunState; summary: string;
  verification: 'insufficient'; limitations: string[];
};
