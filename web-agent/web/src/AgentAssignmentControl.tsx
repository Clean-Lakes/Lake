import {useEffect,useRef,useState} from 'react';
import type {SpecialistChannelInfo} from '../../shared/contracts';
import {agentBackendName,externalAgentNames,type AgentBackendRef,type ExternalAgentStatus,type SpecialistAgentAssignment} from '../../shared/external-agents';
import {api,readableError} from './api';
import {AppSelect} from './AppSelect';
import {Glyph} from './Icons';
import {ExecutionAgentIcon} from './ExecutionAgentIcon';

export type AgentAssignmentDraft={sessionId:string;assignment:SpecialistAgentAssignment;blockedReason?:string;checking?:boolean};
type Target='conversation'|'native'|'runtime-acp'|'codex';
const names:Record<Target,string>={conversation:'专员对话',native:'Lake Worker',...externalAgentNames};
export function AgentAssignmentControl({channel,disabled=false,refreshVersion,onChange,onSettings}:{channel:SpecialistChannelInfo;disabled?:boolean;refreshVersion?:boolean;onChange:(draft:AgentAssignmentDraft|null)=>void;onSettings:()=>void}){
 const [target,setTarget]=useState<Target>('conversation'),[agents,setAgents]=useState<ExternalAgentStatus[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState(''),[refresh,setRefresh]=useState(0);
 const request=useRef(crypto.randomUUID());
 useEffect(()=>{
  const controller=new AbortController();setLoading(true);setError('');
  void api.externalAgents(channel.projectId,controller.signal).then(result=>{if(!controller.signal.aborted)setAgents(result.agents);})
   .catch(cause=>{if(!controller.signal.aborted)setError(readableError(cause));})
   .finally(()=>{if(!controller.signal.aborted)setLoading(false);});
  return()=>controller.abort();
 },[channel.projectId,refreshVersion,refresh]);
 const selected=agents.find(agent=>agent.id===target);
 const blockedReason=target==='conversation'?undefined:!channel.roleRevision?'正在读取专员配置':target==='native'?undefined:
  loading?'正在检查 Agent 连接':error||(!selected?'未取得 Agent 配置':selected.assignmentReady?'':selected.assignmentBlocker||'请先完成 Agent 配置');
 useEffect(()=>{
  if(target==='conversation'){onChange(null);return;}
  const execution:AgentBackendRef=target==='native'?{kind:'native'}:{kind:'acp',agent:target,revision:selected?.revision};
  onChange({sessionId:channel.sessionId,assignment:{requestId:request.current,roleRevision:channel.roleRevision??0,execution},blockedReason:blockedReason||undefined,checking:target!=='native'&&loading});
 },[target,selected?.revision,channel.sessionId,channel.roleRevision,blockedReason,loading,onChange]);
 const select=(value:string)=>{request.current=crypto.randomUUID();setTarget(value as Target);};
 const defaultName=agentBackendName(channel.execution??{kind:'native'});
 return <div className={`agent-assignment-control${target!=='conversation'?' is-assignment':''}`} aria-label="专员执行分配">
  <div className="agent-assignment-row"><span className="agent-assignment-caption"><Glyph name="layers" size={15}/>执行分配</span>
   <AppSelect label="选择对话或分配执行 Agent" value={target} disabled={disabled} onChange={event=>select(event.target.value)} className="agent-assignment-select" popupClassName="agent-assignment-popup" popupMinWidth={280}
    icon={target==='conversation'?<Glyph name="chat" size={15}/>:<ExecutionAgentIcon agent={target} size={15}/>}
    renderValue={target==='conversation'?'专员对话':`分配给 ${names[target]}`}
    renderOption={option=>{const id=option.value as Target,agent=agents.find(agent=>agent.id===id);return <><span className="agent-assignment-option-icon">{id==='conversation'?<Glyph name="chat" size={17}/>:<ExecutionAgentIcon agent={id} size={17}/>}</span><span className="agent-assignment-option-copy"><strong>{id==='conversation'?'专员对话':`分配给 ${names[id]}`}</strong><small>{id==='conversation'?`按对话安排 · 新任务默认 ${defaultName}`:id==='native'?'新建独立任务 · Lake 原生执行':loading?'正在检查连接…':agent?.assignmentReady?'新建独立任务 · ACP 连接已验证':agent?.assignmentBlocker||'需要配置 Agent'}</small></span></>;}}
    popupFooter={<div className="agent-assignment-menu-note">选择执行 Agent 后发送，将创建新任务。已有任务保留原执行者。</div>}
   ><option value="conversation">专员对话</option><optgroup label="分配新任务"><option value="native">分配给 Lake Worker</option><option value="runtime-acp">分配给 {names['runtime-acp']}</option><option value="codex">分配给 Codex</option></optgroup></AppSelect>
   <button className="agent-assignment-settings" type="button" aria-label="当前项目 Agent 设置" disabled={disabled} onClick={onSettings}><Glyph name="settings" size={14}/><span>Agent 设置</span></button>
  </div>
  {target!=='conversation'?<>
   <div className="agent-assignment-path"><span>{channel.roleName}</span><Glyph name="chevron" size={12}/><span>新任务 Worker</span>{target!=='native'&&<><Glyph name="chevron" size={12}/><ExecutionAgentIcon agent={target} size={14}/><strong>{names[target]}</strong><small>ACP</small></>}</div>
   <p className="agent-assignment-hint" role="status" data-blocked={!!blockedReason}>{blockedReason?<><Glyph name={loading?'loader':'alert'} size={13}/>{blockedReason}{!loading&&<button type="button" disabled={disabled} onClick={onSettings}>去配置</button>}</>:<><Glyph name="check" size={13}/>发送后分配新任务，执行进度和结果回到当前专员。</>}</p>
  </>:<p className="agent-assignment-hint">新任务默认由 {defaultName} 执行。可在这里明确分配 Codex 或 {names['runtime-acp']}。</p>}
  {error&&target==='conversation'&&<p className="agent-assignment-hint" role="status">Agent 配置未能读取<button type="button" onClick={()=>setRefresh(value=>value+1)}>重试</button></p>}
 </div>;
}
