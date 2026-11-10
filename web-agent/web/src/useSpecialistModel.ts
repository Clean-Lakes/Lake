import {useCallback,useEffect,useRef,useState} from 'react';
import type {SpecialistChannelInfo} from '../../shared/contracts';
import type {AgentBackendRef,ExternalAgentStatus,SpecialistAgentAssignment} from '../../shared/external-agents';
import {api,readableError} from './api';

export function useSpecialistModel(channel:SpecialistChannelInfo|undefined,settingsOpen:boolean,menuOpen=false,settingsProjectId?:string){
 const [agent,setAgent]=useState<ExternalAgentStatus>(),[loading,setLoading]=useState(false),[error,setError]=useState(''),[saving,setSaving]=useState(false);
 const [override,setOverride]=useState<{sessionId:string;roleRevision:number;execution:AgentBackendRef}>();
 const request=useRef({sessionId:'',id:crypto.randomUUID()}),flight=useRef(false);
 const sessionId=channel?.sessionId,projectId=channel?.projectId??settingsProjectId;
 if(request.current.sessionId!==sessionId)request.current={sessionId:sessionId??'',id:crypto.randomUUID()};
 useEffect(()=>{
  const controller=new AbortController();setAgent(undefined);setError('');
  if(!projectId){setLoading(false);return;}
  setLoading(true);
  void api.externalAgents(projectId,controller.signal).then(result=>{if(!controller.signal.aborted)setAgent(result.agents.find(agent=>agent.id==='codex'));})
   .catch(cause=>{if(!controller.signal.aborted)setError(readableError(cause));})
   .finally(()=>{if(!controller.signal.aborted)setLoading(false);});
  return()=>controller.abort();
 },[projectId,settingsOpen,menuOpen]);
 const current=override&&override.sessionId===sessionId&&(override.roleRevision>(channel?.roleRevision??0))?{...channel!,...override}:channel;
 const selected=!!current&&(current.execution?.kind!=='native');
 const select=useCallback(async(kind:'codex'|'native')=>{
  if(!current||flight.current)return;
  flight.current=true;setSaving(true);
  try{
   const execution:AgentBackendRef=kind==='native'?{kind:'native'}:{kind:'acp',agent:'codex'};
   const updated=await api.setRoleExecution(current.projectId,current.roleId,current.roleRevision!,execution);
   setOverride({sessionId:current.sessionId,roleRevision:updated.revision,execution:updated.execution});
   request.current={sessionId:current.sessionId,id:crypto.randomUUID()};
  }finally{flight.current=false;setSaving(false);}
 },[current?.sessionId,current?.projectId,current?.roleId,current?.roleRevision]);
 const message=loading?'正在读取 Codex 配置':error||agent?.assignmentBlocker||(!agent?.assignmentReady?'请先配置 Codex':undefined);
 const blocker=selected?message:undefined;
 const assignment=():SpecialistAgentAssignment|undefined=>selected&&current?{requestId:request.current.id,roleRevision:current.roleRevision!,execution:{kind:'acp',agent:'codex',revision:agent?.revision}}:undefined;
 return {selected,agent,loading,saving,blocker,message,select,assignment,accepted:()=>{request.current.id=crypto.randomUUID();}};
}
