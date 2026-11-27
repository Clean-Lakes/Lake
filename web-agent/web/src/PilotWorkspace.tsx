import {hasUnreadMessages} from './ConversationReadMarker';
import {useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState,type PointerEvent,type RefObject} from 'react';
import {createPortal} from 'react-dom';
import type {SessionEvent,SuperWorkspace,SuperWorker,SpecialistChannelInfo} from '../../shared/contracts';
import {api,readableError} from './api';
import {greetRoleAvatar,SuperRoleAvatar} from './SuperRoleAvatar';
import {conversationAvatarMotion,superAvatarMotion,channelTaskPresentation,specialistTaskActivity,type ConversationActivity,type ConversationAvatarActivity} from './superAgentPresentation';
import {Glyph} from './Icons';
import {NavigationMenu} from './NavigationDelete';
import {SpecialistCreate} from './SpecialistCreate';
import {SpecialistDelete} from './SpecialistDelete';
import {TabSelectionIndicator} from './TabSelectionIndicator';
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

export function pilotConversationView(workspace:SuperWorkspace|null,sessionId?:string):SuperWorkspace|null {
 if(!workspace?.active||!sessionId)return null;
 const group=workspace.chatGroups?.find(row=>row.sessionId===sessionId&&row.projectId===workspace.project.projectId);
 if(!group&&workspace.project.routerSessionId!==sessionId)return null;
 return {...workspace,
  project:group?{...workspace.project,routerSessionId:sessionId}:workspace.project,
  workers:workspace.workers.filter(worker=>worker.pilotSessionId===group?.sessionId),
  questions:workspace.questions?.filter(question=>question.pilotSessionId===group?.sessionId),
  channels:group?workspace.channels?.filter(channel=>group.members.some(member=>member.roleId===channel.roleId)):workspace.channels,
  conversations:workspace.conversations?.filter(round=>round.sessionId===sessionId),
  ...(group&&{cursor:group.cursor,pilotMessageRead:undefined}),
 };
}

export function usePilotWorkspace(projectId:string|undefined,connected:boolean,visiblePilotSessionId?:string){
 const [loadedWorkspace,setWorkspace]=useState<SuperWorkspace|null>(null),[error,setError]=useState('');
 const workspace=loadedWorkspace?.project.projectId===projectId?loadedWorkspace:null;
 const generation=useRef(0),rosterRevision=useRef(0),refreshRef=useRef<()=>Promise<void>>(async()=>{});
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
   const roster=rosterRevision.current;
   try{
    let next=await api.superWorkspace(projectId,controller.signal);
    if(!next.active&&Date.now()>=nextActivation){nextActivation=Date.now()+15000;await api.ensureSuperWorkspace(projectId,controller.signal);next=await api.superWorkspace(projectId,controller.signal);}
    if(generation.current===current&&roster===rosterRevision.current){
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
   }catch(reason){if(!controller.signal.aborted&&generation.current===current&&roster===rosterRevision.current)setError(readableError(reason));}
   finally{busy=false;if(queued&&!controller.signal.aborted){queued=false;void refresh();}}
  };
  refreshRef.current=refresh;
  void refresh();const timer=window.setInterval(()=>void refresh(),2500);
  return()=>{controller.abort();refreshRef.current=async()=>{};window.clearInterval(timer);};
 },[projectId,connected]);
 const conversation=useMemo(()=>pilotConversationView(workspace,visiblePilotSessionId),[workspace,visiblePilotSessionId]);
 const routerId=conversation?.project.routerSessionId??(workspace?.active?workspace.project.routerSessionId:undefined);
 const workerScope=JSON.stringify(conversation?conversation.workers.filter(worker=>!worker.parentWorkerId&&
  (['active','queued'].includes(worker.assignmentState)||worker.pilotReport?.executionSettled===false)).map(worker=>worker.sessionId).sort():[]);
 const cursor=useRef(0);cursor.current=(conversation??workspace)?.cursor??0;
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
 const addRole=(channel:SpecialistChannelInfo)=>{
  // Discard an in-flight poll that started before this creation was saved.
  rosterRevision.current++;
  setWorkspace(current=>current?.project.projectId===channel.projectId&&!current.channels?.some(row=>row.roleId===channel.roleId)
   ? {...current,channels:[...(current.channels??[]),channel]}:current);
  void refreshRef.current();
 };
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
 return {workspace,conversation,error,addRole,removeRole,readChannel,refresh:()=>refreshRef.current(),subscribeWorkerEvents:conversation?subscribeWorkerEvents:undefined};
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
 showHeading?:boolean;
 presentation?:'list'|'entry'|'rail';
 workspace: SuperWorkspace | null; error: string; selectedId: string | null; selectedRoleId?: string;
 activity?:ConversationAvatarActivity; pilotButton?:RefObject<HTMLButtonElement|null>;
 pilotActivity?:ConversationActivity;pilotDisabled?:boolean;
 onPilot: () => void; onWorker: (worker: SuperWorker) => void; onChannel?: (channel: SpecialistChannelInfo) => void;
 disabled?:boolean; onDeleted?:(channel:SpecialistChannelInfo)=>void;
 onCodexSettings?:(projectId:string,anchor:HTMLButtonElement|null)=>void;
 onSpecialistMcp?:(channel:SpecialistChannelInfo,anchor:HTMLButtonElement|null)=>void;
 createSpecialist?:{projectId:string;onCreated:(channel:SpecialistChannelInfo)=>void};
};
function showClippedText(event: PointerEvent<HTMLElement>) {
 const text = event.currentTarget;
 if (text.scrollWidth > text.clientWidth) text.title = text.textContent ?? '';
 else text.removeAttribute('title');
}

function SpecialistNameBubble({name,target,onClose}:{name:string;target:HTMLButtonElement;onClose:()=>void}) {
 const bubble=useRef<HTMLSpanElement>(null);
 useLayoutEffect(()=>{
  const node=bubble.current;
  if(!node)return;
  const roster=target.closest('.sidebar-specialist-roster');
  const place=()=>{
   const bounds=target.getBoundingClientRect(),visible=roster?.getBoundingClientRect();
   if(!target.isConnected||target.closest('[inert]')||bounds.right<=0||!visible||bounds.bottom<=visible.top||bounds.top>=visible.bottom){
    onClose();
    return;
   }
   const center=bounds.top+bounds.height/2,height=node.offsetHeight;
   const top=Math.max(8,Math.min(center-height/2,window.innerHeight-height-8));
   node.style.left=`${bounds.right+12}px`;
   node.style.top=`${top}px`;
   node.style.setProperty('--specialist-bubble-tail',`${Math.min(height-8,Math.max(8,center-top))}px`);
  };
  const escape=(event:KeyboardEvent)=>{if(event.key==='Escape')onClose();};
  place();
  window.addEventListener('resize',place);
  window.addEventListener('scroll',place,true);
  window.addEventListener('keydown',escape);
  return()=>{
   window.removeEventListener('resize',place);
   window.removeEventListener('scroll',place,true);
   window.removeEventListener('keydown',escape);
  };
 },[target,name,onClose]);
 return createPortal(<span ref={bubble} className="specialist-name-bubble" aria-hidden="true">{name}</span>,document.body);
}

export function PilotWorkspace({workspace,error,selectedId,selectedRoleId,activity,pilotButton,pilotActivity='idle',pilotDisabled=false,onPilot,onWorker,onChannel,disabled=false,onDeleted,onCodexSettings,onSpecialistMcp,createSpecialist,showHeading=true,presentation='list'}: PilotWorkspaceProps) {
 const [menu,setMenu]=useState<SpecialistChannelInfo|null>(null),[deleting,setDeleting]=useState<SpecialistChannelInfo|null>(null),[creating,setCreating]=useState(false);
 const lastMenu=useRef<SpecialistChannelInfo|null>(null);
 if(menu)lastMenu.current=menu;
 const renderedMenu=menu??lastMenu.current;
 const [nameHint,setNameHint]=useState<{id:string;target:HTMLButtonElement}|null>(null);
 const anchor=useRef<HTMLButtonElement|null>(null),createButton=useRef<HTMLButtonElement|null>(null);
 const closeNameHint=useCallback(()=>setNameHint(null),[]);
 useEffect(()=>{lastMenu.current=null;setMenu(null);setDeleting(null);setCreating(false);closeNameHint();},[workspace?.project.projectId,closeNameHint]);
 const roots = workspace?.active?workspace.workers.filter(worker => !worker.parentWorkerId):[];
 const channels = workspace?.active?workspace.channels:undefined;
 const viewedRole = selectedId ? selectedRoleId ?? channels?.find(channel => channel.sessionId === selectedId)?.roleId ??
  roots.find(worker => worker.sessionId === selectedId)?.roleId : undefined;
 const readMarks = useCompletionReads(presentation==='entry'?null:workspace, viewedRole);
 const rail=presentation==='rail';
 const routerId=workspace?.active?workspace.project.routerSessionId:undefined;
 const entries = channels ? channels.map(channel => ({channel, workers: roots.filter(worker => worker.roleId === channel.roleId)})) :
  roots.map(worker => ({channel: undefined, workers: [worker]}));
 const hintedEntry=nameHint&&entries.find(({channel,workers})=>(channel?.id??workers[0].id)===nameHint.id);
 const hintedName=hintedEntry&&(hintedEntry.channel?.roleName??hintedEntry.workers[0].roleName);
 if(rail&&!entries.length&&!createSpecialist)return null;
 return <section className={rail?'sidebar-specialist-roster':'pilot-workspace'} aria-label={rail||showHeading?'专员':undefined}>
  {!rail&&<>
   {showHeading&&<div className="nav-heading"><span>专员</span><small>{entries.length+1}</small></div>}
   <SidebarPilotEntry buttonRef={pilotButton} selected={!!routerId&&selectedId===routerId}
    activity={routerId&&activity?.sessionId===routerId?activity.state:pilotActivity} messageRead={workspace?.active?workspace.pilotMessageRead:undefined}
    disabled={pilotDisabled} onPilot={onPilot}/>
   {error&&<p className="pilot-workspace-error" role="status">{error}</p>}
  </>}
  {presentation!=='entry'&&entries.map(({channel, workers}) => {
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
   const detailStatus = detail.endsWith(status) ? undefined : status;
   const label = `${name}${backend?` · Agent 类型：${agentTypeName(backend)}`:''} · ${detail}${detailStatus?` · ${detailStatus}`:''}`;
   const id=channel?.id??worker!.id;
   const dismissRowHint=()=>setNameHint(current=>current?.id===id?null:current);
   const openManagement=(button:HTMLButtonElement)=>{
    if(!channel||disabled)return;
    closeNameHint();
    anchor.current=button;
    setMenu(channel);
   };
   const avatar=<SuperRoleAvatar name={name} roleId={channel?.roleId??worker?.roleId}
     motion={preparing?'working':replyActivity?conversationAvatarMotion(replyActivity,task?.state):superAvatarMotion(running,task?.state)}/>;
   return <button type="button" key={id} className={rail?'sidebar-rail-button sidebar-specialist-button':`nav-row pilot-worker-row${selected ? ' active' : ''}`}
     aria-current={selected ? 'page' : undefined} aria-label={label}
     aria-keyshortcuts={channel&&!disabled?'Shift+F10':undefined}
     onPointerEnter={rail?event=>{if(event.pointerType==='mouse'&&!menu&&!deleting)setNameHint({id,target:event.currentTarget});}:undefined}
     onPointerLeave={rail?dismissRowHint:undefined}
     onFocus={rail?event=>{if(event.currentTarget.matches(':focus-visible')&&!menu&&!deleting)setNameHint({id,target:event.currentTarget});}:undefined}
     onBlur={rail?dismissRowHint:undefined}
     onContextMenu={event=>{event.preventDefault();event.stopPropagation();openManagement(event.currentTarget);}}
     onKeyDown={event=>{
      if(channel&&!disabled&&(event.key==='ContextMenu'||event.shiftKey&&event.key==='F10')){
       event.preventDefault();
       openManagement(event.currentTarget);
      }
     }}
     onClick={event=>{
      closeNameHint();
      greetRoleAvatar(event.currentTarget);
      if(channel&&onChannel)onChannel(channel);else if(worker)onWorker(worker);
     }}>
    {avatar}
    {rail?<span className="sidebar-specialist-status" aria-hidden="true">
     {needsConfirmation?<Glyph name="circleAlert" size={10}/>:activityLabel?<Glyph name="loader" size={10} className="activity-indicator"/>:showUnread?<span className="pilot-worker-unread"/>:null}
    </span>:<span className="nav-row-text">
     <span className="pilot-worker-name">
      <strong onPointerEnter={showClippedText}>{name}</strong>
      <AgentBackendLogo backend={backend} size={12}/>
     </span>
     <span className="pilot-worker-summary" title={detailStatus}>
      <span className="pilot-worker-task" onPointerEnter={showClippedText}>{detail}</span>
      <span className="pilot-worker-status">
       {aggregate.runningCount>1&&<span className="pilot-worker-count" aria-label={`${aggregate.runningCount} 项任务执行中`}>{aggregate.runningCount}</span>}
       {needsConfirmation && <span className="pilot-worker-confirmation">需确认</span>}
       {activityLabel ? <span className="pilot-worker-running" role="img" aria-label={activityLabel}><Glyph name="loader" size={12} className="activity-indicator"/></span> : showUnread && <span className="pilot-worker-unread" role="img" aria-label="有新消息未读"/>}
      </span>
     </span>
    </span>}
   </button>;
  })}
  {rail&&createSpecialist&&<button ref={createButton} type="button" className="sidebar-rail-button sidebar-specialist-create"
   aria-label="新建专员" title="新建专员" disabled={disabled}
   onClick={()=>{closeNameHint();setCreating(true);}}>
   <Glyph name="plus" size={18}/>
  </button>}
  {rail&&<TabSelectionIndicator className="sidebar-specialist-selection" selection={viewedRole??''} selector='.sidebar-specialist-button[aria-current="page"]'/>}
  {rail&&nameHint&&hintedName&&<SpecialistNameBubble key={nameHint.id} name={hintedName} target={nameHint.target} onClose={closeNameHint}/>}
  {renderedMenu&&<NavigationMenu key={renderedMenu.id} open={Boolean(menu)} title={renderedMenu.roleName} placement="beside" anchor={anchor} className="specialist-context-menu"
   headerIcon={<SuperRoleAvatar name={renderedMenu.roleName} roleId={renderedMenu.roleId} avatarId={renderedMenu.avatarId} motion="still" size={19}/>}
   onClose={()=>setMenu(null)} actions={[
   ...(onCodexSettings?[{label:'模型配置',icon:'filter' as const,trailingIcon:'next' as const,disabled,run:()=>onCodexSettings(renderedMenu.projectId,anchor.current)}]:[]),
   ...(onSpecialistMcp?[{label:'MCP 接入',icon:'plug' as const,trailingIcon:'next' as const,disabled,run:()=>onSpecialistMcp(renderedMenu,anchor.current)}]:[]),
   {label:'删除专员',icon:'trash',separatorBefore:true,danger:true,disabled:disabled||renderedMenu.roleRevision===undefined,run:()=>setDeleting(renderedMenu)},
  ]}/>}
  {deleting&&<SpecialistDelete channel={deleting} returnFocus={anchor} onClose={()=>setDeleting(null)} onDeleted={()=>{
   onDeleted?.(deleting);
   if(deleting.roleId===viewedRole){
    onPilot();
    anchor.current=pilotButton?.current??null;
    anchor.current?.scrollIntoView({block:'nearest'});
   }
  }}/>}
  {creating&&createSpecialist&&<SpecialistCreate projectId={createSpecialist.projectId} disabled={disabled} returnFocus={createButton}
   onCreated={createSpecialist.onCreated} onClose={()=>setCreating(false)}/>}
 </section>;
}
