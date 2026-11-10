export type ExternalAgentId = 'runtime-acp' | 'codex';
export const externalAgentNames:Record<ExternalAgentId,string>={'runtime-acp':'ZCode',codex:'Codex'};
export type AgentBackendRef = {kind:'native'} | {kind:'acp';agent:ExternalAgentId;revision?:number};
export type ExternalAgentStatus = {id:ExternalAgentId;projectId:string;revision:number;enabled:boolean;name:string;installed:boolean;transportReady:boolean;assignmentReady?:boolean;assignmentBlocker?:string;nodePath?:string;model?:string;message?:string;updatedAt:string};

/** Operator input for a new task in one exact specialist channel. Never a tool permission. */
export type SpecialistAgentAssignment = {requestId:string;roleRevision:number;execution:AgentBackendRef};
export type ExternalAgentRunSummary = {
 id:string;agent:ExternalAgentId;state:'starting'|'running'|'completed'|'failed'|'cancelled'|'interrupted'|'unknown';
 dispatchPhase:'not_sent'|'dispatching'|'sent'|'answered';externalSessionId?:string;childSessionId?:string;
 scope:'worker'|'child'|'segment';createdAt:string;updatedAt:string;summary?:string;error?:string;
 usage:{inputTokens:number;outputTokens:number}|null;
};
export type AgentExecutionSummary = {backend:AgentBackendRef;source:'task_assignment'|'specialist_default';assignedAt:string;runs:ExternalAgentRunSummary[];totalRuns:number};

export function agentBackendName(backend:AgentBackendRef){return backend.kind==='native'?'Lake Worker':externalAgentNames[backend.agent];}
