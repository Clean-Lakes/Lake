import {useEffect,useRef,useState} from 'react';
import type {SuperWorkspace,SuperWorker,SpecialistChannelInfo} from '../../shared/contracts';
import {api,readableError} from './api';
import {SuperRoleAvatar} from './SuperRoleAvatar';
import {superAvatarMotion,superTaskPresentation} from './superAgentPresentation';
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

type ReadMark = {requested: string; acknowledged: string; pending: boolean};

function readKey(channel: SpecialistChannelInfo) {
 return JSON.stringify([channel.projectId, channel.roleId]);
}

// Keep a viewed completion read while its request and the next poll cross.
// The host's monotonic cursor is the durable source across ports and windows.
function useCompletionReads(workspace: SuperWorkspace | null, viewedRole: string | undefined) {
 const marks = useRef(new Map<string, ReadMark>());
 useEffect(() => {
  if (!workspace?.active || !workspace.channels) return;
  const channels = workspace.channels;
  const sync = () => {
   for (const channel of channels) {
    const key = readKey(channel);
    const cursor = channel.completionCursor ?? '';
    let mark = marks.current.get(key);
    if (!document.hidden && channel.roleId === viewedRole && cursor > (channel.seenCompletionCursor ?? '')) {
     if (!mark) {
      mark = {requested: cursor, acknowledged: '', pending: false};
      marks.current.set(key, mark);
     } else if (cursor > mark.requested) mark.requested = cursor;
    }
    if (!mark || mark.pending || mark.requested <= (channel.seenCompletionCursor ?? '') || mark.requested <= mark.acknowledged) continue;
    const saving = mark;
    saving.pending = true;
    api.readSpecialistCompletion(channel.sessionId, saving.requested).then(result => {
     if (result.cursor > saving.acknowledged) saving.acknowledged = result.cursor;
    }).catch(() => { /* Retry the viewed cursor on the next workspace snapshot. */ })
      .finally(() => {saving.pending = false;});
   }
  };
  sync();
  document.addEventListener('visibilitychange', sync);
  return () => document.removeEventListener('visibilitychange', sync);
 }, [workspace, viewedRole]);
 return marks.current;
}

type PilotWorkspaceProps = {
 workspace: SuperWorkspace | null; error: string; selectedId: string | null; selectedRoleId?: string;
 onPilot: () => void; onWorker: (worker: SuperWorker) => void; onChannel?: (channel: SpecialistChannelInfo) => void;
};

export function PilotWorkspace({workspace,error,selectedId,selectedRoleId,onPilot,onWorker,onChannel}: PilotWorkspaceProps) {
 const roots = workspace?.workers?.filter(worker => !worker.parentWorkerId) ?? [];
 const channels = workspace?.channels;
 const viewedRole = selectedId ? selectedRoleId ?? channels?.find(channel => channel.sessionId === selectedId)?.roleId ??
  roots.find(worker => worker.sessionId === selectedId)?.roleId : undefined;
 const readMarks = useCompletionReads(workspace, viewedRole);
 if (!workspace?.active) return error ? <p className="pilot-workspace-error" role="status">{error}</p> : null;
 const entries = channels ? channels.map(channel => ({channel, workers: roots.filter(worker => worker.roleId === channel.roleId)})) :
  roots.map(worker => ({channel: undefined, workers: [worker]}));
 return <section className="pilot-workspace" aria-label="Pilot 与专员">
  <button type="button" className={`nav-row pilot-workspace-entry${selectedId===workspace.project.routerSessionId?' active':''}`} aria-current={selectedId===workspace.project.routerSessionId?'page':undefined} title="Pilot · 持续沟通，自动安排工作" onClick={onPilot}>
   <SuperRoleAvatar pilot/><span className="nav-row-text"><strong>Pilot</strong></span><Glyph name="arrow" size={14}/>
  </button>
  <div className="nav-heading"><span>专员</span><small>{entries.length}</small></div>
  {entries.length ? entries.map(({channel, workers}) => {
   const worker = workers[0], task = worker?.task;
   const name = channel?.roleName ?? worker!.roleName;
   const selected = channel ? channel.roleId === viewedRole : worker?.sessionId === selectedId;
   const needsConfirmation = channel?.needsConfirmation || workers.some(row => row.task.state === 'waiting_user');
   const running = channel ? channel.running === true : task?.state === 'running';
   const cursor = channel?.completionCursor ?? '';
   const read = channel ? readMarks.get(readKey(channel)) : undefined;
   const unread = !!channel && !selected && cursor > (channel.seenCompletionCursor ?? '') &&
    cursor > (read?.requested ?? '') && cursor > (read?.acknowledged ?? '');
   const status = [needsConfirmation && '需确认', running && '执行中', unread && '有已完成任务未读'].filter(Boolean).join(' · ') ||
    (task && task.state !== 'running' ? superTaskPresentation(task).label : task ? '暂无正在执行的任务' : '暂无任务');
   const label = `${name} · ${task?.title ?? (channel?.duties || '持续沟通')} · ${status}`;
   return <button type="button" key={channel?.id ?? worker!.id} className={`nav-row pilot-worker-row${selected ? ' active' : ''}`}
     aria-current={selected ? 'page' : undefined} aria-label={label} title={label}
     onClick={() => channel && onChannel ? onChannel(channel) : worker && onWorker(worker)}>
    <SuperRoleAvatar name={name} roleId={channel?.roleId??worker?.roleId} motion={superAvatarMotion(running,task?.state)}/><span className="nav-row-text"><strong>{name}</strong><span className="pilot-worker-task">{task?.title ?? (channel?.duties || '持续沟通')}</span></span>
    <span className="pilot-worker-status">
     {needsConfirmation && <span className="pilot-worker-confirmation">需确认</span>}
     {running ? <span className="pilot-worker-running" role="img" aria-label="执行中"><Glyph name="loader" size={14} className="activity-indicator"/></span> :
      unread && <span className="pilot-worker-unread" role="img" aria-label="有已完成任务未读"/>}
    </span>
   </button>;
  }) : <p className="pilot-workspace-empty">告诉 Pilot 你的目标，它会安排合适的专员。</p>}
 </section>;
}
