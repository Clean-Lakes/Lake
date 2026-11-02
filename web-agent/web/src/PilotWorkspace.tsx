import {useEffect,useRef,useState} from 'react';
import type {SuperWorkspace,SuperWorker} from '../../shared/contracts';
import {api,readableError} from './api';
import {LakeLogo} from './LakeLogo';
import {Glyph} from './Icons';

export const superTaskLabels:Record<SuperWorker['task']['state'],string>={queued:'排队中',running:'执行中',waiting_external:'等待外部结果',waiting_user:'需要你回答',paused:'已暂停',blocked:'待核实',completed:'已验收',failed:'执行失败',cancelled:'已停止跟进'};

export function usePilotWorkspace(projectId:string|undefined,connected:boolean){
 const [workspace,setWorkspace]=useState<SuperWorkspace|null>(null),[error,setError]=useState('');
 const generation=useRef(0);
 useEffect(()=>{
  const current=++generation.current;setWorkspace(null);setError('');
  if(!projectId||!connected)return;
  const controller=new AbortController();let busy=false,activated=false;
  const refresh=async()=>{
   if(busy)return;busy=true;
   try{
    let next=await api.superWorkspace(projectId,controller.signal);
    if(!next.active&&!activated){activated=true;await api.ensureSuperWorkspace(projectId,controller.signal);next=await api.superWorkspace(projectId,controller.signal);}
    if(generation.current===current){setWorkspace(next);if(next.active)setError('');}
   }catch(reason){if(!controller.signal.aborted&&generation.current===current)setError(readableError(reason));}
   finally{busy=false;}
  };
  void refresh();const timer=window.setInterval(()=>void refresh(),2500);
  return()=>{controller.abort();window.clearInterval(timer);};
 },[projectId,connected]);
 return {workspace,error};
}

export function PilotWorkspace({workspace,error,selectedId,onPilot,onWorker}:{workspace:SuperWorkspace|null;error:string;selectedId:string|null;onPilot:()=>void;onWorker:(worker:SuperWorker)=>void}){
 if(!workspace?.active)return error?<p className="pilot-workspace-error" role="status">{error}</p>:null;
 const roots=workspace.workers.filter(worker=>!worker.parentWorkerId);
 return <section className="pilot-workspace" aria-label="Pilot 与专员">
  <button type="button" className={`nav-row pilot-workspace-entry${selectedId===workspace.project.routerSessionId?' active':''}`} aria-current={selectedId===workspace.project.routerSessionId?'page':undefined} onClick={onPilot}>
   <LakeLogo/><span className="nav-row-text"><strong>Pilot</strong><small>持续沟通，自动安排工作</small></span><Glyph name="arrow" size={14}/>
  </button>
  <div className="nav-heading"><span>专员</span><small>{roots.length}</small></div>
  {roots.length?roots.map(worker=><button type="button" key={worker.id} className={`nav-row pilot-worker-row${selectedId===worker.sessionId?' active':''}`} aria-current={selectedId===worker.sessionId?'page':undefined} onClick={()=>onWorker(worker)}>
   <span className="pilot-worker-avatar"><Glyph name="spark" size={16}/></span><span className="nav-row-text"><strong>{worker.roleName}</strong><span className="pilot-worker-task" title={worker.task.title}>{worker.task.title}</span><small>{superTaskLabels[worker.task.state]}</small></span><span className={`pilot-worker-dot state-${worker.task.state}`} aria-label={superTaskLabels[worker.task.state]}/>
  </button>):<p className="pilot-workspace-empty">告诉 Pilot 你的目标，它会安排合适的专员。</p>}
 </section>;
}
