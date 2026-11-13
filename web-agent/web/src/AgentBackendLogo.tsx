import type {AgentBackendRef} from '../../shared/external-agents';
import {externalAgentName} from '../../shared/external-agents';
import {ExecutionAgentIcon} from './ExecutionAgentIcon';

/** Agent identity comes from the host binding, never the role name or model. */
export function agentTypeName(backend?:AgentBackendRef){
 return backend?.kind==='native'?'Lake':backend?.kind==='acp'?externalAgentName(backend.agent):undefined;
}

export function AgentBackendLogo({backend,size=14}:{backend?:AgentBackendRef;size?:number}){
 const name=agentTypeName(backend);
 if(!backend||!name)return null;
 return <span className="agent-backend-logo" role="img" aria-label={`Agent 类型：${name}`} title={`Agent 类型：${name}`} data-agent-type={backend.kind==='acp'?backend.agent:'native'}>
  <ExecutionAgentIcon agent={backend.kind==='acp'?backend.agent:undefined} size={size}/>
 </span>;
}
