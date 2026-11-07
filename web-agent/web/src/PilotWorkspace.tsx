import {hasUnreadMessages} from './ConversationReadMarker';
import {useEffect,useRef,useState,type RefObject} from 'react';
import type {SuperWorkspace,SuperWorker,SpecialistChannelInfo} from '../../shared/contracts';
import {api,readableError} from './api';
import {greetRoleAvatar,SuperRoleAvatar} from './SuperRoleAvatar';
import {conversationAvatarMotion,superAvatarMotion,channelTaskPresentation,specialistTaskActivity,type ConversationAvatarActivity} from './superAgentPresentation';
import {Glyph} from './Icons';
import {NavigationMenu} from './NavigationDelete';
import {SpecialistDelete} from './SpecialistDelete';

export function usePilotWorkspace(projectId:string|undefined,connected:boolean){
 const [workspace,setWorkspace]=useState<SuperWorkspace|null>(null),[error,setError]=useState('');
 const generation=useRef(0),refreshRef=useRef<()=>void>(()=>{});
 const deletedRoles=useRef(new Set<string>());
 useEffect(()=>{
  const current=++generation.current;deletedRoles.current.clear();setWorkspace(null);setError('');
  if(!projectId||!connected)return;
  const controller=new AbortController();let busy=false,queued=false,nextActivation=0;
  const refresh=async()=>{
   if(busy){queued=true;return;}busy=true;
   try{
    let next=await api.superWorkspace(projectId,controller.signal);
    if(!next.active&&Date.now()>=nextActivation){nextActivation=Date.now()+15000;await api.ensureSuperWorkspace(projectId,controller.signal);next=await api.superWorkspace(projectId,controller.signal);}
    if(generation.current===current){setWorkspace({...next,channels:next.channels?.filter(channel=>!deletedRoles.current.has(channel.roleId)),workers:next.workers.filter(worker=>!deletedRoles.current.has(worker.roleId))});if(next.active)setError('');}
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
  stream.addEventListener('specialist',refresh);stream.addEventListener('message',refresh);stream.addEventListener('open',refresh);
  return()=>stream.close();
 },[routerId,connected]);
 useEffect(()=>{const refresh=()=>refreshRef.current();window.addEventListener('lake:conversation-read',refresh);return()=>window.removeEventListener('lake:conversation-read',refresh);},[]);
 const removeRole=(roleId:string)=>{deletedRoles.current.add(roleId);setWorkspace(current=>current?{...current,channels:current.channels?.filter(channel=>channel.roleId!==roleId),workers:current.workers.filter(worker=>worker.roleId!==roleId)}:current);refreshRef.current();};
 return {workspace,error,removeRole};
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
    if(channel.messageRead)continue;
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
 activity?:ConversationAvatarActivity; pilotButton?:RefObject<HTMLButtonElement|null>;
 onPilot: () => void; onWorker: (worker: SuperWorker) => void; onChannel?: (channel: SpecialistChannelInfo) => void;
 disabled?:boolean; onDeleted?:(channel:SpecialistChannelInfo)=>void;
};

export function PilotWorkspace({workspace,error,selectedId,selectedRoleId,activity,pilotButton,onPilot,onWorker,onChannel,disabled=false,onDeleted}: PilotWorkspaceProps) {
 const [context,setContext]=useState<{channel:SpecialistChannelInfo;x:number;y:number}|null>(null),[deleting,setDeleting]=useState<SpecialistChannelInfo|null>(null);
 const anchor=useRef<HTMLButtonElement|null>(null);
 useEffect(()=>{setContext(null);setDeleting(null);},[workspace?.project.projectId]);
 const roots = workspace?.workers?.filter(worker => !worker.parentWorkerId) ?? [];
 const channels = workspace?.channels;
 const viewedRole = selectedId ? selectedRoleId ?? channels?.find(channel => channel.sessionId === selectedId)?.roleId ??
  roots.find(worker => worker.sessionId === selectedId)?.roleId : undefined;
 const readMarks = useCompletionReads(workspace, viewedRole);
 if (!workspace?.active) return error ? <p className="pilot-workspace-error" role="status">{error}</p> : null;
 const entries = channels ? channels.map(channel => ({channel, workers: roots.filter(worker => worker.roleId === channel.roleId)})) :
  roots.map(worker => ({channel: undefined, workers: [worker]}));
 return <section className="pilot-workspace" aria-label="专员">
  <div className="nav-heading"><span>专员</span><small>{entries.length}</small></div>
  {entries.length ? entries.map(({channel, workers}) => {
   const aggregate=specialistTaskActivity(workers),worker = aggregate.worker, task = worker?.task;
   const name = channel?.roleName ?? worker!.roleName;
   const selected = channel ? channel.roleId === viewedRole : worker?.sessionId === selectedId;
   // Only the host can attest that a live, source-bound interaction exists.
   // A task's waiting state (including older protocol snapshots) is not one.
   const needsConfirmation = channel?.needsConfirmation === true;
   const running = channel ? channel.running === true : task?.state === 'running';
   const replyActivity=activity&&(activity.sessionId===channel?.sessionId||workers.some(row=>row.sessionId===activity.sessionId))?activity.state:undefined;
   const preparing = channel?.preparing === true;
   const activityLabel = running ? '执行中' : preparing ? '准备处理' : '';
   const cursor = channel?.completionCursor ?? '';
   const read = channel ? readMarks.get(readKey(channel)) : undefined;
   const unread = channel?.messageRead ? hasUnreadMessages(channel.messageRead) : !!channel && !selected && cursor > (channel.seenCompletionCursor ?? '') &&
    cursor > (read?.requested ?? '') && cursor > (read?.acknowledged ?? '');
   const showUnread = unread && !activityLabel;
   const status = [needsConfirmation && '需确认', activityLabel, showUnread && '有新消息未读'].filter(Boolean).join(' · ') ||
    (task && task.state !== 'running' ? channelTaskPresentation(task).label : task ? '暂无正在执行的任务' : '暂无任务');
   const detail=aggregate.detail??(channel?.duties||'持续沟通');
   const label = `${name} · ${detail}${detail.endsWith(status)?'':` · ${status}`}`;
   return <button type="button" key={channel?.id ?? worker!.id} className={`nav-row pilot-worker-row${selected ? ' active' : ''}`}
     aria-current={selected ? 'page' : undefined} aria-label={label} title={label}
     aria-haspopup={channel?'menu':undefined}
     onContextMenu={event=>{event.preventDefault();event.stopPropagation();if(channel&&!disabled){anchor.current=event.currentTarget;setContext({channel,x:event.clientX,y:event.clientY});}}}
     onKeyDown={event=>{if(channel&&!disabled&&(event.key==='ContextMenu'||event.shiftKey&&event.key==='F10')){event.preventDefault();const bounds=event.currentTarget.getBoundingClientRect();anchor.current=event.currentTarget;setContext({channel,x:bounds.left+20,y:bounds.bottom});}}}
     onClick={event=>{greetRoleAvatar(event.currentTarget);if(channel&&onChannel)onChannel(channel);else if(worker)onWorker(worker);}}>
    <SuperRoleAvatar name={name} roleId={channel?.roleId??worker?.roleId} motion={preparing?'working':replyActivity?conversationAvatarMotion(replyActivity,task?.state):superAvatarMotion(running,task?.state)}/><span className="nav-row-text"><strong>{name}</strong><span className="pilot-worker-task">{detail}</span></span>
    <span className="pilot-worker-status">
     {aggregate.runningCount>1&&<span className="pilot-worker-count" aria-label={`${aggregate.runningCount} 项任务执行中`}>{aggregate.runningCount}</span>}
     {needsConfirmation && <span className="pilot-worker-confirmation">需确认</span>}
     {activityLabel ? <span className="pilot-worker-running" role="img" aria-label={activityLabel}><Glyph name="loader" size={14} className="activity-indicator"/></span> : showUnread && <span className="pilot-worker-unread" role="img" aria-label="有新消息未读"/>}
    </span>
   </button>;
  }) : <p className="pilot-workspace-empty">告诉 Pilot 你的目标，它会执行或安排专员协作。</p>}
  {context&&<NavigationMenu title={context.channel.roleName} x={context.x} y={context.y} anchor={anchor} onClose={()=>setContext(null)} actions={[{label:'删除专员',icon:'trash',danger:true,disabled:disabled||context.channel.roleRevision===undefined,run:()=>setDeleting(context.channel)}]}/>}
  {deleting&&<SpecialistDelete channel={deleting} returnFocus={anchor} onClose={()=>setDeleting(null)} onDeleted={()=>{onDeleted?.(deleting);if(deleting.roleId===viewedRole){onPilot();anchor.current=pilotButton?.current??null;}}}/>}
 </section>;
}
