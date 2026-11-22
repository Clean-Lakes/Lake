import type {AICard} from './contracts';
export type ExternalAgentId = 'codex';
export type ExternalRuntimeKind = 'codex-app-server';
/** Read compatibility only; retired bindings never authorize a new run. */
export type StoredExternalAgentId = ExternalAgentId | 'runtime-acp';
export const externalAgentNames:Record<ExternalAgentId,string>={codex:'Codex'};
export function externalAgentName(agent:StoredExternalAgentId){return agent==='codex'?'Codex':'已移除的 Agent';}
export function externalExecutionName(agent:StoredExternalAgentId,runtimeKind?:ExternalRuntimeKind){
 return agent==='codex'&&runtimeKind==='codex-app-server'?'Codex · CLI':externalAgentName(agent);
}
/** Old host-generated titles used the compatibility binding as a protocol label. */
export function executionCardTitle(card:AICard){
 const data=card.data as Record<string,unknown>|undefined;
 if(card.type!=='operation'||data?.source!=='external_agent')return card.title;
 const agent=data.external_agent;
 if(agent==='codex'||agent==='runtime-acp')return externalExecutionName(agent,
  data.external_run_id===card.id&&data.external_runtime_kind==='codex-app-server'?'codex-app-server':undefined);
 return card.title==='Codex · ACP'?'Codex':card.title;
}
export type AgentModelRef = {modelId:string;providerId?:string};
export type AgentBackendRef = {kind:'native';model?:AgentModelRef} | {kind:'acp';agent:StoredExternalAgentId;revision?:number;model?:AgentModelRef};
export type CodexProjectOverrides = {modelOverride?:string;reasoningEffortOverride?:string};
export type ExternalAgentStatus = CodexProjectOverrides & {
 id:ExternalAgentId;projectId:string;revision:number;enabled:boolean;name:string;installed:boolean;transportReady:boolean;
 assignmentReady?:boolean;assignmentBlocker?:string;nodePath?:string;npmPath?:string;
 model?:string;defaultTaskModel?:string;modelOptions?:string[];modelProvider?:string;
 reasoningEffort?:string;reasoningEffortOptions?:string[];configPath?:string;authMode?:'chatgpt'|'api_key'|'provider'|'none';
 message?:string;updatedAt:string;
};

/** Operator input for a new task in one exact specialist channel. Never a tool permission. */
export type SpecialistAgentAssignment = {requestId:string;roleRevision:number;execution:AgentBackendRef};
export type ExternalAgentRunSummary = {
 runtimeKind?:ExternalRuntimeKind;
 id:string;agent:StoredExternalAgentId;state:'starting'|'running'|'completed'|'failed'|'cancelled'|'interrupted'|'unknown';
 dispatchPhase:'not_sent'|'dispatching'|'sent'|'answered';externalSessionId?:string;childSessionId?:string;
 scope:'worker'|'child'|'segment'|'conversation';createdAt:string;updatedAt:string;summary?:string;error?:string;
 usage:{inputTokens:number;outputTokens:number}|null;
};
export type AgentExecutionSummary = {backend:AgentBackendRef;source:'task_assignment'|'specialist_default';assignedAt:string;runs:ExternalAgentRunSummary[];totalRuns:number};

export function agentBackendName(backend:AgentBackendRef){return backend.kind==='native'?'Lake Worker':externalAgentName(backend.agent);}
