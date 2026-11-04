import {useEffect,useRef,useState} from 'react';
import type {SuperWorkspace,SuperWorker,SpecialistChannelInfo} from '../../shared/contracts';
import {api,readableError} from './api';
import {SuperRoleAvatar} from './SuperRoleAvatar';
import {superTaskPresentation} from './superAgentPresentation';
import {Glyph} from './Icons';

export function usePilotWorkspace(projectId:string|undefined,connected:boolean){
 const [workspace,setWorkspace]=useState<SuperWorkspace|null>(null),[error,setError]=useState('');
 const generation=useRef(0),refreshRef=useRef<()=>void>(()=>{});
 useEffect(()=>{
  const current=++generation.current;setWorkspace(null);setError('');
  if(!projectId||!connected)return;
  const controller=new AbortController();let busy=false,queued=false,nextActivation=0;
  const refresh=async()=>{
   if(busy){queued=true;return;}busy=true;
   try{
    let next=await api.superWorkspace(projectId,controller.signal);
    if(!next.active&&Date.now()>=nextActivation){nextActivation=Date.now()+15000;await api.ensureSuperWorkspace(projectId,controller.signal);next=await api.superWorkspace(projectId,controller.signal);}
    if(generation.current===current){setWorkspace(next);if(next.active)setError('');}
   }catch(reason){if(!controller.signal.aborted&&generation.current===current)setError(readableError(reason));}
   finally{busy=false;if(queued&&!controller.signal.aborted){queued=false;void refresh();}}
  };
  refreshRef.current=()=>void refresh();
  void refresh();const timer=window.setInterval(()=>void refresh(),2500);
  return()=>{controller.abort();refreshRef.current=()=>{};window.clearInterval(timer);};
 },[projectId,connected]);
 const routerId=workspace?.active?workspace.project.routerSessionId:undefined;
 const cursor=useRef(0);cursor.current=workspace?.cursor??0;
 useEffect(()=>{
  if(!routerId||!connected||typeof EventSource==='undefined')return;
  const stream=new EventSource(api.eventsUrl(routerId,cursor.current),{withCredentials:true});
  const refresh=()=>refreshRef.current();
  stream.addEventListener('specialist',refresh);stream.addEventListener('open',refresh);
  return()=>stream.close();
 },[routerId,connected]);
 return {workspace,error};
}

export function PilotWorkspace({workspace,error,selectedId,onPilot,onWorker,onChannel}:{workspace:SuperWorkspace|null;error:string;selectedId:string|null;onPilot:()=>void;onWorker:(worker:SuperWorker)=>void;onChannel?:(channel:SpecialistChannelInfo)=>void}){
 if(!workspace?.active)return error?<p className="pilot-workspace-error" role="status">{error}</p>:null;
 const roots=workspace.workers.filter(worker=>!worker.parentWorkerId);
 const channels=workspace.channels;
 const entries=channels?channels.map(channel=>({channel,worker:roots.find(worker=>worker.roleId===channel.roleId)})):roots.map(worker=>({channel:undefined,worker}));
 return <section className="pilot-workspace" aria-label="Pilot 与专员">
  <button type="button" className={`nav-row pilot-workspace-entry${selectedId===workspace.project.routerSessionId?' active':''}`} aria-current={selectedId===workspace.project.routerSessionId?'page':undefined} title="Pilot · 持续沟通，自动安排工作" onClick={onPilot}>
   <SuperRoleAvatar pilot/><span className="nav-row-text"><strong>Pilot</strong></span><Glyph name="arrow" size={14}/>
  </button>
  <div className="nav-heading"><span>专员</span><small>{entries.length}</small></div>
  {entries.length?entries.map(({channel,worker})=>{const needsConfirmation=channel?.needsConfirmation===true||roots.some(row=>(channel?row.roleId===channel.roleId:row.id===worker?.id)&&row.task.state==='waiting_user');const task=worker?.task,state=task?superTaskPresentation(task):{label:'暂无任务',tone:'muted'},name=channel?.roleName??worker!.roleName,id=channel?.sessionId??worker!.sessionId,selected=selectedId===id||!!channel&&roots.some(row=>row.roleId===channel.roleId&&row.sessionId===selectedId),label=`${name} · ${task?.title??(channel?.duties||'持续沟通')} · ${needsConfirmation?'需确认':state.label}`;return <button type="button" key={channel?.id??worker!.id} className={`nav-row pilot-worker-row${selected?' active':''}`} aria-current={selected?'page':undefined} aria-label={label} title={label} onClick={()=>channel&&onChannel?onChannel(channel):worker&&onWorker(worker)}>
   <SuperRoleAvatar name={name}/><span className="nav-row-text"><strong>{name}</strong><span className="pilot-worker-task">{task?.title??(channel?.duties||'持续沟通')}</span></span><span className={`pilot-worker-status${needsConfirmation?" needs-confirmation":""}`}>{needsConfirmation?<span className="pilot-worker-confirmation">需确认</span>:state.tone!=='success'&&task&&<span className="session-status-dot" data-tone={state.tone}/>}</span>
  </button>}):<p className="pilot-workspace-empty">告诉 Pilot 要创建的专员及职责，也可以直接安排任务。</p>}
 </section>;
}
