import {hasCurrentTaskProgress,TaskProgress} from './TaskProgress';
import {ConversationReadMarker} from './ConversationReadMarker';
import {AgentExecution} from './AgentExecution';
import {useEffect,useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import type {SessionSnapshot,SpecialistChannelEntry,SpecialistChannelPage,SuperWorker} from '../../shared/contracts';
import {api,readableError} from './api';
import {AIPending,AITranscript,Card,TranscriptMessage} from './AIPanel';
import {AgentQuestion} from './AgentQuestion';
import {HostKeyTrust} from './HostKeyTrust';
import {ObjectReferencesProvider} from './AssistantMarkdown';
import {conversationActivity,channelTaskPresentation} from './superAgentPresentation';
import {isCompactionFallbackEntry} from './timeline';
import {AppSelect} from './AppSelect';
import {LoadingWaves} from './LoadingWaves';
import {StatusText} from './StatusText';
import {currentChannelReplies,mergeChannelEntries,mergeChannelPage} from './specialistChannelProjection';
import {conversationPlanEntry} from './planConversation';
import {useSmoothText} from './useSmoothText';
import {usePageVisible} from './usePageVisible';
export {mergeChannelEntries} from './specialistChannelProjection';

export function preferredChannelTask(workers:SuperWorker[]){
 return workers.find(worker=>worker.task.state==='waiting_user')??workers.find(worker=>['running','queued','waiting_external'].includes(worker.task.state))??workers[0];
}

export function channelTasksByRecentRecord(workers:SuperWorker[],entries:SpecialistChannelEntry[]){
 const latest=new Map<string,number>();
 for(const entry of entries)latest.set(entry.sourceSessionId,Math.max(latest.get(entry.sourceSessionId)??0,Date.parse(entry.createdAt)||0,Date.parse(entry.message?.createdAt??'')||0));
 return [...workers].sort((a,b)=>(latest.get(b.sessionId)??0)-(latest.get(a.sessionId)??0));
}

export function SpecialistTaskSelect({workers,sessionId,onTask}:{workers:SuperWorker[];sessionId:string;onTask:(sessionId:string)=>void}){
 return <label className="specialist-task-select"><span>任务记录</span><AppSelect aria-label="查看专员任务" value={sessionId} title={workers.find(worker=>worker.sessionId===sessionId)?.task.title} onChange={event=>onTask(event.target.value)}>{workers.map(worker=><option key={worker.id} value={worker.sessionId}>{worker.task.title} · {channelTaskPresentation(worker.task).label}</option>)}</AppSelect></label>;
}

export function SpecialistLiveReply({text,worker,snapshot,connected=true}:{text?:string;worker?:SuperWorker;snapshot?:SessionSnapshot;connected?:boolean}){
 const visible=usePageVisible();
 const activity=worker?.activity;
 const waiting=conversationActivity(snapshot?.ai)==='waiting'||!!activity&&['waiting_approval','waiting_input','waiting_external','queued'].includes(activity.phase);
 const moving=connected&&!waiting&&conversationActivity(snapshot?.ai)==='running';
 const label=!connected?'进度暂未更新，正在重连':waiting?activity?.label??'等待确认后继续':text?.trim()||activity?.label||'正在思考…';
 const shown=useSmoothText(label,moving);
 return <div className={`specialist-live-reply${moving?' is-running':''}`} role="status" aria-live="polite" aria-atomic="true" data-phase={!connected?'disconnected':waiting?'waiting':moving?'running':'idle'}>
  {moving&&<LoadingWaves/>}<SpecialistReplyTransition revision="progress" text={label} enabled={moving&&visible}><StatusText active={moving&&visible}>{shown}</StatusText></SpecialistReplyTransition>
 </div>;
}

/** Animate actual replacements, not every token, poll or history restoration. */
export function SpecialistReplyTransition({revision,text='',enabled=true,children}:{revision:string;text?:string;enabled?:boolean;children:ReactNode}){
 const element=useRef<HTMLDivElement>(null),previous=useRef({revision,text});
 useLayoutEffect(()=>{
  const old=previous.current;previous.current={revision,text};
  if(old.revision===revision&&(old.text===text||text.startsWith(old.text)))return;
  if(!enabled||document.hidden||window.matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  const animation=element.current?.animate?.([{opacity:.45,transform:'translateY(4px)'},{opacity:1,transform:'translateY(0)'}],{duration:220,easing:'ease-out'});
  const finish=()=>animation?.cancel();
  const motion=window.matchMedia('(prefers-reduced-motion: reduce)');
  document.addEventListener('visibilitychange',finish);motion.addEventListener('change',finish);
  return()=>{finish();document.removeEventListener('visibilitychange',finish);motion.removeEventListener('change',finish);};
 },[revision,text,enabled]);
 return <div ref={element} className="specialist-reply-transition">{children}</div>;
}

function SpecialistReplyMeta({entry,worker,previous=false,latest=true}:{entry:SpecialistChannelEntry;worker?:SuperWorker;previous?:boolean;latest?:boolean}){
 const name=entry.message?.author?.name??worker?.roleName;
 const time=new Date(entry.createdAt),valid=Number.isFinite(time.getTime());
 // A paged channel cannot know a global round number. Use the original start
 // time and frozen author instead of renumbering when more history is loaded.
 return <div className="specialist-reply-meta"><span>{previous?'历史轮次':latest?'最新一轮':'执行记录'}</span>{name&&<span>{name}</span>}{valid&&<time dateTime={entry.createdAt} title="本轮记录时间">{time.toLocaleString('zh-CN',{hour12:false})}</time>}</div>;
}

export function SpecialistChannelEntries({entries,resources,workers=[],activeSources,activeSnapshots,connected=true,onTask}:{entries:SpecialistChannelEntry[];resources:SessionSnapshot['resources'];workers?:SuperWorker[];activeSources?:ReadonlySet<string>;activeSnapshots?:ReadonlyMap<string,SessionSnapshot>;connected?:boolean;onTask?:(sessionId:string)=>void}){
 const forwarded=new Set(entries.flatMap(entry=>entry.message?.dispatch?[`${entry.sourceSessionId}\0${entry.message.dispatch.sourceMessageId}`]:[]));
 const byTask=new Map(workers.map(worker=>[worker.task.taskId,worker])),bySession=new Map(workers.map(worker=>[worker.sessionId,worker]));
 const current=currentChannelReplies(entries);
 let previousTask:string|undefined;
 return <>{current.entries.filter(entry=>!entry.message?.dispatch&&!isCompactionFallbackEntry(entry)&&!(entry.message?.role==='user'&&forwarded.has(`${entry.sourceSessionId}\0${entry.message.id}`))).map(entry=>{
  const active=activeSnapshots?.get(entry.sourceSessionId);
  const taskId=entry.taskId??bySession.get(entry.sourceSessionId)?.task.taskId;
  const startsTask=!!taskId&&taskId!==previousTask;
  if(taskId)previousTask=taskId;
  const task=taskId?byTask.get(taskId)?.task:undefined;
  const taskTitle=taskId?task?.title??active?.superagent?.task.title??'任务记录':'';
  // Keep the channel key, but plan metadata refers to the original source ID.
  // Project before Markdown so neither live nor saved plans mount their body.
  const projected=conversationPlanEntry({id:entry.card?.id??entry.message?.id??entry.id,at:entry.createdAt,card:entry.card,message:entry.message},{planMode:active?.conversationMode==='plan',live:active?.ai?.status==='running',currentPlanId:active?.ai?.proposedPlan?.id});
  const history=current.history.get(entry.id)??[];
  return <div className="specialist-channel-entry" key={current.keys.get(entry.id)??entry.id} data-channel-entry={entry.id} data-source-session={entry.sourceSessionId} data-task-id={taskId}>
   {startsTask&&<div className="specialist-task-divider" role="separator" aria-label={`任务：${taskTitle}`} data-task-divider={taskId}><span title={taskTitle}>{taskTitle}{task?.collaboration&&` · ${task.collaboration.participants.length} 位专员协作`}</span></div>}
   {startsTask&&<AgentExecution execution={byTask.get(taskId!)?.execution} roleName={byTask.get(taskId!)?.roleName} waiting={byTask.get(taskId!)?.activity?.phase==='waiting_approval'} compact onInspect={onTask&&byTask.get(taskId!)?()=>onTask(byTask.get(taskId!)!.sessionId):undefined}/>}
   <div className="specialist-reply-content" data-reply-state={entry.reply?.state}>
   {entry.reply&&<SpecialistReplyMeta entry={entry} worker={bySession.get(entry.sourceSessionId)} latest={current.keys.has(entry.id)}/>}
   <SpecialistReplyTransition revision={`${entry.reply?.turnId??entry.id}:${entry.reply?.state??''}`} text={entry.reply?.state==='working'?'':entry.message?.text??entry.card?.content} enabled={connected&&!['failed','cancelled','blocked','paused','waiting_user','waiting_external'].includes(bySession.get(entry.sourceSessionId)?.task.state??'')}>
    {entry.reply?.state==='working'&&projected.card?.type!=='plan_reference'?<SpecialistLiveReply text={entry.card?.content} worker={bySession.get(entry.sourceSessionId)} snapshot={active} connected={connected}/>:projected.message?<TranscriptMessage message={projected.message} sessionId={entry.sourceSessionId} resources={resources} hideIdentity/>:projected.card?<Card card={projected.card} streaming={activeSources?projected.card.status==='running'&&activeSources.has(entry.sourceSessionId):undefined}/>:null}
   </SpecialistReplyTransition>
   {history.length>0&&<details className="specialist-reply-history"><summary>之前的 {history.length} 次执行</summary><div>{history.map(previous=>{
    const saved=conversationPlanEntry({id:previous.card?.id??previous.message?.id??previous.id,at:previous.createdAt,card:previous.card,message:previous.message},{planMode:false,live:false});
    return <section key={previous.id} data-reply-history={previous.id}><SpecialistReplyMeta entry={previous} worker={bySession.get(previous.sourceSessionId)} previous/>{saved.message?<TranscriptMessage message={saved.message} sessionId={previous.sourceSessionId} resources={resources} hideIdentity/>:saved.card?<Card card={saved.card} streaming={false}/>:null}</section>;
   })}</div></details>}
   </div>
  </div>;
 })}</>;
}

// Questions, approvals and host trust always use their original task session.
// A display channel must never become the execution/SDK identity.
export function SpecialistTaskControls({snapshot,connected}:{snapshot:SessionSnapshot;connected:boolean}){
 const session=snapshot.session.id,view=snapshot.ai;
 const refresh=()=>api.snapshot(session);
 return <fieldset className="specialist-task-controls" disabled={!connected} aria-label={`任务确认：${snapshot.superagent?.task.title??snapshot.session.title}`}>
  {view?.question&&<AgentQuestion session={session} request={view.question} refresh={refresh}/>}
  {view?.pending&&<AIPending session={session} view={view} attachments={snapshot.messages.flatMap(message=>message.files??[])} refresh={refresh}/>}
  {snapshot.hostKeyTrust&&<HostKeyTrust session={session} prompt={snapshot.hostKeyTrust} disabled={!connected} refresh={refresh}/>}
 </fieldset>;
}

export function SpecialistChannel({snapshot,connected,onTask,onTasks,onActivity,onReady}:{snapshot:SessionSnapshot;connected:boolean;onTask:(sessionId:string)=>void;onTasks?:(sessionId:string,workers:SuperWorker[])=>void;onActivity?:(sessionId:string,state:"running"|"waiting"|"idle")=>void;onReady?:(sessionId:string,ready:boolean)=>void}){
 const session=snapshot.session.id;
 const [page,setPage]=useState<SpecialistChannelPage|null>(null),[entries,setEntries]=useState<SpecialistChannelEntry[]>([]),[error,setError]=useState(''),[loading,setLoading]=useState(false);
 const cursor=useRef(''),hasOlder=useRef(false),generation=useRef(0);
 const refreshCurrent=useRef<()=>void>(()=>{});
 const observed=useRef({session,cursor:snapshot.cursor});
 useLayoutEffect(()=>{onReady?.(session,!!page||!!error);},[!!page,!!error,session,onReady]);
 useEffect(()=>{if(page?.channel.sessionId===session)onTasks?.(session,channelTasksByRecentRecord(page.workers,entries));},[page,entries,session,onTasks]);
 useEffect(()=>{
  // A hidden window / reconnect suspends transport, not the conversation.
  // Clearing history there repeatedly collapses the scroll height and island.
  setPage(null);setEntries([]);setError('');cursor.current='';hasOlder.current=false;
 },[session]);
 useEffect(()=>{
  const current=++generation.current,controller=new AbortController();let busy=false,queued=false;
  if(!connected)return;
  const refresh=async()=>{
   if(busy){queued=true;return;}busy=true;
   try{const next=await api.specialistChannel(session,'',controller.signal);if(current!==generation.current)return;
    setPage(next);setEntries(old=>mergeChannelPage(old,next));setError('');if(!hasOlder.current)cursor.current=next.nextCursor;
   }catch(reason){if(!controller.signal.aborted&&current===generation.current)setError(readableError(reason));}finally{busy=false;if(queued&&!controller.signal.aborted){queued=false;void refresh();}}
  };
  refreshCurrent.current=()=>void refresh();
  void refresh();const timer=window.setInterval(()=>void refresh(),1000);
  return()=>{refreshCurrent.current=()=>{};controller.abort();window.clearInterval(timer);};
 },[session,connected]);
 // The parent already owns channel SSE. Consume its cursor instead of waiting
 // for the fallback poll or opening duplicate EventSources per Worker.
 useEffect(()=>{
  const previous=observed.current;observed.current={session,cursor:snapshot.cursor};
  if(previous.session===session&&previous.cursor!==snapshot.cursor)refreshCurrent.current();
 },[session,snapshot.cursor]);
 const loadOlder=async()=>{
  if(!cursor.current||loading)return;
  const current=generation.current,container=document.querySelector<HTMLElement>('.conversation'),height=container?.scrollHeight??0,top=container?.scrollTop??0;
  setLoading(true);
  try{const older=await api.specialistChannel(session,cursor.current);if(current!==generation.current)return;
   hasOlder.current=true;cursor.current=older.nextCursor;setEntries(old=>mergeChannelEntries(old,older.entries));setError('');
   requestAnimationFrame(()=>{if(container&&current===generation.current)container.scrollTop=top+container.scrollHeight-height;});
  }catch(reason){if(current===generation.current)setError(readableError(reason));}finally{if(current===generation.current)setLoading(false);}
 };
 const latestOwn=snapshot.messages.at(-1);
 const admitting=latestOwn?.role==='user'&&(!page||!entries.length||Date.parse(latestOwn.createdAt)>Date.parse(entries.at(-1)!.createdAt));
 const activity=page?.routing||admitting||!!page?.queued||page?.active.some(active=>conversationActivity(active.ai)==='running')?'running':page?.active.length?'waiting':'idle';
 useEffect(()=>{onActivity?.(session,activity)},[session,activity,onActivity]);
 return <ObjectReferencesProvider resources={snapshot.resources}><div className="ai-transcript specialist-channel" data-reply-avatar="hidden">
  {!!cursor.current&&<button type="button" className="button secondary" disabled={loading} onClick={()=>void loadOlder()}>{loading?'正在加载…':'加载更早记录'}</button>}
  {error&&<p className="pilot-workspace-error" role="alert">{error}</p>}
  <SpecialistChannelEntries entries={entries} resources={snapshot.resources} workers={page?.workers} connected={connected} onTask={onTask} activeSources={new Set(connected?page?.active.map(active=>active.session.id)??[]:[])} activeSnapshots={new Map(page?.active.map(active=>[active.session.id,active])??[])}/>
  {page?.workers.filter(worker=>worker.execution&&!entries.some(entry=>entry.taskId===worker.task.taskId)).map(worker=><section key={worker.id} className="agent-assignment-pending"><div className="specialist-task-divider"><span>{worker.task.title}</span></div><AgentExecution execution={worker.execution} roleName={worker.roleName} onInspect={()=>onTask(worker.sessionId)} compact/></section>)}
  {(page?.routing||admitting||!!page?.queued)&&!page?.active.length&&<div className="reply-duration turn-status is-live is-thinking without-avatar" role="status" aria-label="专员正在处理消息"><LoadingWaves/><StatusText active={connected}>正在安排工作</StatusText></div>}
  {page?.active.map(active=>{
   const task=active.superagent?.task;
   const cards=active.ai?.cards.filter(card=>!!active.ai?.turnStartedAt&&card.at>=active.ai.turnStartedAt)??[];
   const live={...active,messages:[],ai:active.ai?{...active.ai,cards,cardsOffset:0,totalCards:cards.length}:undefined};
   return <section className="specialist-channel-active" key={active.session.id} aria-label={task?.title??'当前任务'}>
    {page.replyPresentation==='invocation'&&task&&<TaskProgress cards={cards} executionId={task.executionGoalId??task.taskId} historical={!hasCurrentTaskProgress(task.state)}/>}
    {page.replyPresentation!=='invocation'&&<AITranscript snapshot={live} proseInChannel superTask={task} assistantIdentity={{name:page.channel.roleName}} disabled={!connected} refresh={()=>api.snapshot(active.session.id)} onInspect={()=>onTask(active.session.id)}/>}
    <SpecialistTaskControls snapshot={active} connected={connected}/>
   </section>;
  })}
  <ConversationReadMarker session={session} state={page?.channel.messageRead} enabled={connected&&!error}/>
 </div></ObjectReferencesProvider>;
}
