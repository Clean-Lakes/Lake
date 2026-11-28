import {useEffect,useRef,useState} from 'react';
import type {SpecialistChannelInfo} from '../../shared/contracts';
import type {ExternalAgentStatus,SpecialistAgentAssignment} from '../../shared/external-agents';
import {externalAgentName,isExternalAgentId} from '../../shared/external-agents';
import {api,readableError} from './api';

export function useSpecialistModel(channel:SpecialistChannelInfo|undefined,configurationOpen:boolean,menuOpen=false,settingsProjectId?:string){
 const [agent,setAgent]=useState<ExternalAgentStatus>(),[loading,setLoading]=useState(false),[error,setError]=useState('');
 const request=useRef({sessionId:'',id:crypto.randomUUID()});
 const sessionId=channel?.sessionId,projectId=channel?.projectId??settingsProjectId;
 const binding=channel?.execution?.kind==='acp'?channel.execution:undefined;
 const agentId=isExternalAgentId(binding?.agent)?binding.agent:'codex';
 const name=externalAgentName(agentId);
 if(request.current.sessionId!==sessionId)request.current={sessionId:sessionId??'',id:crypto.randomUUID()};
 useEffect(()=>{
  const controller=new AbortController();setAgent(undefined);setError('');
  if(!projectId){setLoading(false);return;}
  setLoading(true);
  void api.externalAgents(projectId,controller.signal).then(result=>{if(!controller.signal.aborted)setAgent(result.agents.find(agent=>agent.id===agentId));})
   .catch(cause=>{if(!controller.signal.aborted)setError(readableError(cause));})
   .finally(()=>{if(!controller.signal.aborted)setLoading(false);});
  return()=>controller.abort();
 },[projectId,agentId,configurationOpen,menuOpen]);
 const message=loading?`正在读取 ${name} 配置`:error||agent?.assignmentBlocker||(!agent?.assignmentReady?`请先配置 ${name}`:undefined);
 const savedModel=binding?.agent===agentId?binding.model?.modelId:undefined;
 const model=agent?.modelOverride??savedModel??agent?.defaultTaskModel??agent?.model;
 const assignment=():SpecialistAgentAssignment|undefined=>channel?.roleRevision&&agent?.assignmentReady&&agent.projectId===projectId&&agent.id===agentId
  ? {requestId:request.current.id,roleRevision:channel.roleRevision,execution:{kind:'acp',agent:agent.id,revision:agent.revision}}
  : undefined;
 return {agent,agentId,loading,message,model,assignment,accepted:()=>{request.current.id=crypto.randomUUID();}};
}
