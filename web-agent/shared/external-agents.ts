export type ExternalAgentId = 'codex';
/** Read compatibility only; retired bindings never authorize a new run. */
export type StoredExternalAgentId = ExternalAgentId | 'runtime-acp';
export const externalAgentNames:Record<ExternalAgentId,string>={codex:'Codex'};
export function externalAgentName(agent:StoredExternalAgentId){return agent==='codex'?'Codex':'已移除的 Agent';}
export type AgentModelRef = {modelId:string;providerId?:string};
export type AgentBackendRef = {kind:'native';model?:AgentModelRef} | {kind:'acp';agent:StoredExternalAgentId;revision?:number;model?:AgentModelRef};
export type ExternalAgentStatus = {id:ExternalAgentId;projectId:string;revision:number;enabled:boolean;name:string;installed:boolean;transportReady:boolean;assignmentReady?:boolean;assignmentBlocker?:string;nodePath?:string;npmPath?:string;model?:string;modelProvider?:string;reasoningEffort?:string;configPath?:string;authMode?:'chatgpt'|'api_key'|'provider'|'none';message?:string;updatedAt:string};

/** Operator input for a new task in one exact specialist channel. Never a tool permission. */
export type SpecialistAgentAssignment = {requestId:string;roleRevision:number;execution:AgentBackendRef};
export type ExternalAgentRunSummary = {
 id:string;agent:StoredExternalAgentId;state:'starting'|'running'|'completed'|'failed'|'cancelled'|'interrupted'|'unknown';
 dispatchPhase:'not_sent'|'dispatching'|'sent'|'answered';externalSessionId?:string;childSessionId?:string;
 scope:'worker'|'child'|'segment';createdAt:string;updatedAt:string;summary?:string;error?:string;
 usage:{inputTokens:number;outputTokens:number}|null;
};
export type AgentExecutionSummary = {backend:AgentBackendRef;source:'task_assignment'|'specialist_default';assignedAt:string;runs:ExternalAgentRunSummary[];totalRuns:number};

export function agentBackendName(backend:AgentBackendRef){return backend.kind==='native'?'Lake Worker':externalAgentName(backend.agent);}
