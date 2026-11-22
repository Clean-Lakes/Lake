import {hasUnreadMessages} from './ConversationReadMarker';
import {useCallback,useEffect,useRef,useState,type RefObject} from 'react';
import type {SessionEvent,SuperWorkspace,SuperWorker,SpecialistChannelInfo} from '../../shared/contracts';
import {api,readableError} from './api';
import {greetRoleAvatar,SuperRoleAvatar} from './SuperRoleAvatar';
import {conversationAvatarMotion,superAvatarMotion,channelTaskPresentation,specialistTaskActivity,type ConversationActivity,type ConversationAvatarActivity} from './superAgentPresentation';
import {Glyph} from './Icons';
import {NavigationMenu} from './NavigationDelete';
import {SpecialistDelete} from './SpecialistDelete';
import {SidebarPilotEntry} from './SidebarPilotEntry';
import {AgentBackendLogo,agentTypeName} from './AgentBackendLogo';
import {reuseUnchanged} from './snapshotUpdates';

function withSeenCursor(channel:SpecialistChannelInfo,cursor:string):SpecialistChannelInfo {
 const state=channel.messageRead;
 if(!state||cursor<=state.seenCursor)return channel;
 return {...channel,messageRead:{...state,seenCursor:cursor}};
}

type WorkerEventListener={receive:(event:SessionEvent)=>void;connection:(open:boolean)=>void};
export type SubscribePilotWorkerEvents=(sessionId:string,listener:WorkerEventListener)=>()=>void;

export function usePilotWorkspace(projectId:string|undefined,connected:boolean,visiblePilotSessionId?:string){
 const [loadedWorkspace,setWorkspace]=useState<SuperWorkspace|null>(null),[error,setError]=useState('');
 const workspace=loadedWorkspace?.project.projectId===projectId?loadedWorkspace:null;
 const generation=useRef(0),refreshRef=useRef<()=>Promise<void>>(async()=>{});
 const deletedRoles=useRef(new Set<string>());
 const listeners=useRef(new Map<string,Set<WorkerEventListener>>());
 const streamingWorkers=useRef<ReadonlySet<string>|null>(null);
 const subscribeWorkerEvents=useCallback<SubscribePilotWorkerEvents>((sessionId,listener)=>{
  let set=listeners.current.get(sessionId);
  if(!set)listeners.current.set(sessionId,set=new Set());
  set.add(listener);
  if(streamingWorkers.current?.has(sessionId))listener.connection(true);
  return()=>{set.delete(listener);if(!set.size)listeners.current.delete(sessionId);};
 },[]);
 useEffect(()=>{deletedRoles.current.clear();},[projectId]);
 useEffect(()=>{
  const current=++generation.current;setError('');
  setWorkspace(previous=>previous?.project.projectId===projectId?previous:null);
  if(!projectId||!connected)return;
  const controller=new AbortController();let busy=false,queued=false,nextActivation=0;
  const refresh=async()=>{
   if(busy){queued=true;return;}busy=true;
   try{
    let next=await api.superWorkspace(projectId,controller.signal);
    if(!next.active&&Date.now()>=nextActivation){nextActivation=Date.now()+15000;await api.ensureSuperWorkspace(projectId,controller.signal);next=await api.superWorkspace(projectId,controller.signal);}
    if(generation.current===current){
     setWorkspace(previous=>{
      // A workspace poll started before an acknowledgement can arrive after it.
      const seen=new Map(previous?.project.projectId===next.project.projectId
       ? previous.channels?.map(channel=>[channel.sessionId,channel.messageRead?.seenCursor??''])
       : undefined);
      return reuseUnchanged(previous,{...next,
       questions:next.questions?.filter(question=>!deletedRoles.current.has(question.author.roleId??'')),
       channels:next.channels?.filter(channel=>!deletedRoles.current.has(channel.roleId))
        .map(channel=>withSeenCursor(channel,seen.get(channel.sessionId)??'')),
       workers:next.workers.filter(worker=>!deletedRoles.current.has(worker.roleId)),
      });
     });
     if(next.active)setError('');
    }
   }catch(reason){if(!controller.signal.aborted&&generation.current===current)setError(readableError(reason));}
   finally{busy=false;if(queued&&!controller.signal.aborted){queued=false;void refresh();}}
  };
  refreshRef.current=refresh;
  void refresh();const timer=window.setInterval(()=>void refresh(),2500);
  return()=>{controller.abort();refreshRef.current=async()=>{};window.clearInterval(timer);};
 },[projectId,connected]);
 const routerId=workspace?.active?workspace.project.routerSessionId:undefined;
 const shared=!!routerId&&routerId===visiblePilotSessionId;
 const workerScope=JSON.stringify(shared?workspace!.workers.filter(worker=>!worker.parentWorkerId&&
  (['active','queued'].includes(worker.assignmentState)||worker.pilotReport?.executionSettled===false)).map(worker=>worker.sessionId).sort():[]);
 const cursor=useRef(0);cursor.current=workspace?.cursor??0;
 useEffect(()=>{
  if(!routerId||!connected||typeof EventSource==='undefined')return;
  const workers=new Set<string>(JSON.parse(workerScope));
  const stream=new EventSource(api.eventsUrl(routerId,cursor.current,[...workers]),{withCredentials:true});
  let timer:number|undefined;
  const refresh=()=>{
   if(timer!==undefined)return;
   timer=window.setTimeout(()=>{timer=undefined;void refreshRef.current();},100);
  };
  const ready=(open:boolean)=>{
   streamingWorkers.current=open?workers:null;
   for(const id of workers)for(const listener of listeners.current.get(id)??[])listener.connection(open);
  };
  const receive=(incoming:MessageEvent<string>)=>{
   let event:SessionEvent;
   try{event=JSON.parse(incoming.data);}catch{if(incoming.type!=='session')refresh();return;}
   if(!event)return;
   if(event.sessionId===routerId){
    if(event.pilotSummaryText){
     for(const listener of listeners.current.get(event.pilotSummaryText.roundId)??[])listener.receive(event);
     return;
    }
    if(incoming.type!=='session')refresh();
   }
   else if(workers.has(event.sessionId))for(const listener of listeners.current.get(event.sessionId)??[])listener.receive(event);
  };
  for(const type of ['specialist','message','session'])stream.addEventListener(type,receive as EventListener);
  stream.addEventListener('open',refresh);
  stream.addEventListener('worker-subscriptions',()=>ready(true));
  stream.onerror=()=>ready(false);
  return()=>{stream.close();ready(false);window.clearTimeout(timer);};
 },[routerId,connected,workerScope]);
 useEffect(()=>{const refresh=()=>refreshRef.current();window.addEventListener('lake:conversation-read',refresh);return()=>window.removeEventListener('lake:conversation-read',refresh);},[]);
 const removeRole=(roleId:string)=>{deletedRoles.current.add(roleId);setWorkspace(current=>current?{...current,questions:current.questions?.filter(question=>question.author.roleId!==roleId),channels:current.channels?.filter(channel=>channel.roleId!==roleId),workers:current.workers.filter(worker=>worker.roleId!==roleId)}:current);void refreshRef.current();};
 const readChannel=async(channel:SpecialistChannelInfo)=>{
  const state=channel.messageRead;
  if(!state||!hasUnreadMessages(state))return;
  try {
   const {cursor}=await api.readConversation(channel.sessionId,state.cursor);
   setWorkspace(current=>current?.project.projectId===channel.projectId?{
    ...current,
    channels:current.channels?.map(row=>row.sessionId===channel.sessionId?withSeenCursor(row,cursor):row),
   }:current);
  } catch {
   // The visible overview can retry if the receipt could not be saved.
  }
 };
 return {workspace,error,removeRole,readChannel,refresh:()=>refreshRef.current(),subscribeWorkerEvents:shared?subscribeWorkerEvents:undefined};
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
 showPilot?:boolean;showHeading?:boolean;
 workspace: SuperWorkspace | null; error: string; selectedId: string | null; selectedRoleId?: string;
 activity?:ConversationAvatarActivity; pilotButton?:RefObject<HTMLButtonElement|null>;
 pilotActivity?:ConversationActivity;pilotDisabled?:boolean;
 onPilot: () => void; onWorker: (worker: SuperWorker) => void; onChannel?: (channel: SpecialistChannelInfo) => void;
 disabled?:boolean; onDeleted?:(channel:SpecialistChannelInfo)=>void;
};

export function PilotWorkspace({workspace,error,selectedId,selectedRoleId,activity,pilotButton,pilotActivity='idle',pilotDisabled=false,onPilot,onWorker,onChannel,disabled=false,onDeleted,showPilot=true,showHeading=true}: PilotWorkspaceProps) {
 const [context,setContext]=useState<{channel:SpecialistChannelInfo;x:number;y:number}|null>(null),[deleting,setDeleting]=useState<SpecialistChannelInfo|null>(null);
 const anchor=useRef<HTMLButtonElement|null>(null);
 useEffect(()=>{setContext(null);setDeleting(null);},[workspace?.project.projectId]);
 const roots = workspace?.active?workspace.workers.filter(worker => !worker.parentWorkerId):[];
 const channels = workspace?.active?workspace.channels:undefined;
 const viewedRole = selectedId ? selectedRoleId ?? channels?.find(channel => channel.sessionId === selectedId)?.roleId ??
  roots.find(worker => worker.sessionId === selectedId)?.roleId : undefined;
 const readMarks = useCompletionReads(workspace, viewedRole);
 const routerId=workspace?.active?workspace.project.routerSessionId:undefined;
 const entries = channels ? channels.map(channel => ({channel, workers: roots.filter(worker => worker.roleId === channel.roleId)})) :
  roots.map(worker => ({channel: undefined, workers: [worker]}));
 return <section className="pilot-workspace" aria-label="专员">
  {showHeading&&<div className="nav-heading"><span>专员</span><small>{entries.length+1}</small></div>}
  {showPilot&&<SidebarPilotEntry buttonRef={pilotButton} selected={!!routerId&&selectedId===routerId}
   activity={routerId&&activity?.sessionId===routerId?activity.state:pilotActivity} messageRead={workspace?.active?workspace.pilotMessageRead:undefined}
   disabled={pilotDisabled} onPilot={onPilot}/>}
  {error&&<p className="pilot-workspace-error" role="status">{error}</p>}
  {entries.length ? entries.map(({channel, workers}) => {
   const aggregate=specialistTaskActivity(workers),worker = aggregate.worker, task = worker?.task;
   const name = channel?.roleName ?? worker!.roleName;
   const backend = channel ? channel.execution : worker?.execution?.backend;
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
   const label = `${name}${backend?` · Agent 类型：${agentTypeName(backend)}`:''} · ${detail}${detail.endsWith(status)?'':` · ${status}`}`;
   return <button type="button" key={channel?.id ?? worker!.id} className={`nav-row pilot-worker-row${selected ? ' active' : ''}`}
     aria-current={selected ? 'page' : undefined} aria-label={label} title={label}
     aria-haspopup={channel?'menu':undefined}
     onContextMenu={event=>{event.preventDefault();event.stopPropagation();if(channel&&!disabled){anchor.current=event.currentTarget;setContext({channel,x:event.clientX,y:event.clientY});}}}
     onKeyDown={event=>{if(channel&&!disabled&&(event.key==='ContextMenu'||event.shiftKey&&event.key==='F10')){event.preventDefault();const bounds=event.currentTarget.getBoundingClientRect();anchor.current=event.currentTarget;setContext({channel,x:bounds.left+20,y:bounds.bottom});}}}
     onClick={event=>{greetRoleAvatar(event.currentTarget);if(channel&&onChannel)onChannel(channel);else if(worker)onWorker(worker);}}>
    <SuperRoleAvatar name={name} roleId={channel?.roleId??worker?.roleId} motion={preparing?'working':replyActivity?conversationAvatarMotion(replyActivity,task?.state):superAvatarMotion(running,task?.state)}/><span className="nav-row-text"><span className="pilot-worker-name"><strong>{name}</strong><AgentBackendLogo backend={backend}/></span><span className="pilot-worker-task">{detail}</span></span>
    <span className="pilot-worker-status">
     {aggregate.runningCount>1&&<span className="pilot-worker-count" aria-label={`${aggregate.runningCount} 项任务执行中`}>{aggregate.runningCount}</span>}
     {needsConfirmation && <span className="pilot-worker-confirmation">需确认</span>}
     {activityLabel ? <span className="pilot-worker-running" role="img" aria-label={activityLabel}><Glyph name="loader" size={14} className="activity-indicator"/></span> : showUnread && <span className="pilot-worker-unread" role="img" aria-label="有新消息未读"/>}
    </span>
   </button>;
  }) : null}
  {context&&<NavigationMenu title={context.channel.roleName} x={context.x} y={context.y} anchor={anchor} onClose={()=>setContext(null)} actions={[{label:'删除专员',icon:'trash',danger:true,disabled:disabled||context.channel.roleRevision===undefined,run:()=>setDeleting(context.channel)}]}/>}
  {deleting&&<SpecialistDelete channel={deleting} returnFocus={anchor} onClose={()=>setDeleting(null)} onDeleted={()=>{onDeleted?.(deleting);if(deleting.roleId===viewedRole){onPilot();anchor.current=pilotButton?.current??null;}}}/>}
 </section>;
}
