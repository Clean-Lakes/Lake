import {useEffect,useRef,useState} from 'react';
import type {Resource,SuperWorkspace,SuperWorker} from '../../shared/contracts';
import {ProjectSecurityPolicy} from './ProjectSecurityPolicy';
import {api,readableError} from './api';
import {SuperRoleAvatar} from './SuperRoleAvatar';
import {superTaskPresentation} from './superAgentPresentation';
import {Glyph} from './Icons';

export function usePilotWorkspace(projectId:string|undefined,connected:boolean){
 const [workspace,setWorkspace]=useState<SuperWorkspace|null>(null),[error,setError]=useState('');
 const generation=useRef(0);
 useEffect(()=>{
  const current=++generation.current;setWorkspace(null);setError('');
  if(!projectId||!connected)return;
  const controller=new AbortController();let busy=false,nextActivation=0;
  const refresh=async()=>{
   if(busy)return;busy=true;
   try{
    let next=await api.superWorkspace(projectId,controller.signal);
    if(!next.active&&Date.now()>=nextActivation){nextActivation=Date.now()+15000;await api.ensureSuperWorkspace(projectId,controller.signal);next=await api.superWorkspace(projectId,controller.signal);}
    if(generation.current===current){setWorkspace(next);if(next.active)setError('');}
   }catch(reason){if(!controller.signal.aborted&&generation.current===current)setError(readableError(reason));}
   finally{busy=false;}
  };
  void refresh();const timer=window.setInterval(()=>void refresh(),2500);
  return()=>{controller.abort();window.clearInterval(timer);};
 },[projectId,connected]);
 return {workspace,error};
}

export function PilotWorkspace({workspace,error,selectedId,onPilot,onWorker,resources=[]}:{workspace:SuperWorkspace|null;error:string;selectedId:string|null;onPilot:()=>void;onWorker:(worker:SuperWorker)=>void;resources?:Resource[]}){
 if(!workspace?.active)return error?<p className="pilot-workspace-error" role="status">{error}</p>:null;
 const roots=workspace.workers.filter(worker=>!worker.parentWorkerId);
 return <section className="pilot-workspace" aria-label="Pilot 与专员">
  <button type="button" className={`nav-row pilot-workspace-entry${selectedId===workspace.project.routerSessionId?' active':''}`} aria-current={selectedId===workspace.project.routerSessionId?'page':undefined} title="Pilot · 持续沟通，自动安排工作" onClick={onPilot}>
   <SuperRoleAvatar pilot/><span className="nav-row-text"><strong>Pilot</strong></span><Glyph name="arrow" size={14}/>
  </button>
  <ProjectSecurityPolicy key={workspace.project.projectId} projectId={workspace.project.projectId} resources={resources.filter(resource=>resource.projectId===workspace.project.projectId)}/>
  <div className="nav-heading"><span>专员</span><small>{roots.length}</small></div>
  {roots.length?roots.map(worker=>{const state=superTaskPresentation(worker.task),label=`${worker.roleName} · ${worker.task.title} · ${state.label}`;return <button type="button" key={worker.id} className={`nav-row pilot-worker-row${selectedId===worker.sessionId?' active':''}`} aria-current={selectedId===worker.sessionId?'page':undefined} aria-label={label} title={label} onClick={()=>onWorker(worker)}>
   <SuperRoleAvatar name={worker.roleName}/><span className="nav-row-text"><strong>{worker.roleName}</strong><span className="pilot-worker-task">{worker.task.title}</span></span><span className="pilot-worker-status" aria-hidden="true">{state.tone!=='success'&&<span className="session-status-dot" data-tone={state.tone}/>}</span>
  </button>}):<p className="pilot-workspace-empty">告诉 Pilot 你的目标，它会安排合适的专员。</p>}
 </section>;
}
