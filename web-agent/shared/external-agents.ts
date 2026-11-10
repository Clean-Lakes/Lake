export type ExternalAgentId = 'runtime-acp' | 'codex';
export type AgentBackendRef = {kind:'native'} | {kind:'acp';agent:ExternalAgentId;revision?:number};
export type ExternalAgentStatus = {id:ExternalAgentId;projectId:string;revision:number;enabled:boolean;name:string;installed:boolean;transportReady:boolean;nodePath?:string;model?:string;message?:string;updatedAt:string};
