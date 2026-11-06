import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import type {SessionSnapshot,SpecialistChannelEntry,SpecialistChannelPage,SuperWorker} from '../../shared/contracts';
import {api,readableError} from './api';
import {AIPending,AITranscript,Card,TranscriptMessage} from './AIPanel';
import {AgentQuestion} from './AgentQuestion';
import {HostKeyTrust} from './HostKeyTrust';
import {ObjectReferencesProvider} from './AssistantMarkdown';
import {conversationActivity,superTaskPresentation} from './superAgentPresentation';
import {isCompactionFallbackEntry} from './timeline';
import {AppSelect} from './AppSelect';
import {LoadingWaves} from './LoadingWaves';
import {StatusText} from './StatusText';
import {mergeChannelEntries,mergeChannelPage} from './specialistChannelProjection';
import {conversationPlanEntry} from './planConversation';
export {mergeChannelEntries} from './specialistChannelProjection';

export function preferredChannelTask(workers:SuperWorker[]){
 return workers.find(worker=>worker.task.state==='waiting_user')??workers.find(worker=>['running','queued','waiting_external'].includes(worker.task.state))??workers[0];
}

export function channelTasksByRecentRecord(workers:SuperWorker[],entries:SpecialistChannelEntry[]){
 const latest=new Map<string,number>();
 for(const entry of entries)latest.set(entry.sourceSessionId,Math.max(latest.get(entry.sourceSessionId)??0,Date.parse(entry.createdAt)||0));
 return [...workers].sort((a,b)=>(latest.get(b.sessionId)??0)-(latest.get(a.sessionId)??0));
}

export function SpecialistTaskSelect({workers,sessionId,onTask}:{workers:SuperWorker[];sessionId:string;onTask:(sessionId:string)=>void}){
 return <label className="specialist-task-select"><span>任务记录</span><AppSelect aria-label="查看专员任务" value={sessionId} title={workers.find(worker=>worker.sessionId===sessionId)?.task.title} onChange={event=>onTask(event.target.value)}>{workers.map(worker=><option key={worker.id} value={worker.sessionId}>{worker.task.title} · {superTaskPresentation(worker.task).label}</option>)}</AppSelect></label>;
}

export function SpecialistChannelEntries({entries,resources,workers=[],activeSources,activeSnapshots}:{entries:SpecialistChannelEntry[];resources:SessionSnapshot['resources'];workers?:SuperWorker[];activeSources?:ReadonlySet<string>;activeSnapshots?:ReadonlyMap<string,SessionSnapshot>}){
 const forwarded=new Set(entries.flatMap(entry=>entry.message?.dispatch?[`${entry.sourceSessionId}\0${entry.message.dispatch.sourceMessageId}`]:[]));
 const byTask=new Map(workers.map(worker=>[worker.task.taskId,worker])),bySession=new Map(workers.map(worker=>[worker.sessionId,worker]));
 let previousTask:string|undefined;
 return <>{entries.filter(entry=>!entry.message?.dispatch&&!isCompactionFallbackEntry(entry)&&!(entry.message?.role==='user'&&forwarded.has(`${entry.sourceSessionId}\0${entry.message.id}`))).map(entry=>{
  const active=activeSnapshots?.get(entry.sourceSessionId);
  const taskId=entry.taskId??bySession.get(entry.sourceSessionId)?.task.taskId;
  const startsTask=!!taskId&&taskId!==previousTask;
  if(taskId)previousTask=taskId;
  const taskTitle=taskId?byTask.get(taskId)?.task.title??active?.superagent?.task.title??'任务记录':'';
  // Keep the channel key, but plan metadata refers to the original source ID.
  // Project before Markdown so neither live nor saved plans mount their body.
  const projected=conversationPlanEntry({id:entry.card?.id??entry.message?.id??entry.id,at:entry.createdAt,card:entry.card,message:entry.message},{planMode:active?.conversationMode==='plan',live:active?.ai?.status==='running',currentPlanId:active?.ai?.proposedPlan?.id});
  return <div className="specialist-channel-entry" key={entry.id} data-channel-entry={entry.id} data-source-session={entry.sourceSessionId} data-task-id={taskId}>
   {startsTask&&<div className="specialist-task-divider" role="separator" aria-label={`任务：${taskTitle}`} data-task-divider={taskId}><span title={taskTitle}>{taskTitle}</span></div>}
   {projected.message?<TranscriptMessage message={projected.message} sessionId={entry.sourceSessionId} resources={resources} hideIdentity/>:projected.card?<Card card={projected.card} streaming={activeSources?projected.card.status==='running'&&activeSources.has(entry.sourceSessionId):undefined}/>:null}
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
 useLayoutEffect(()=>{onReady?.(session,!!page||!!error);},[!!page,!!error,session,onReady]);
 useEffect(()=>{if(page?.channel.sessionId===session)onTasks?.(session,channelTasksByRecentRecord(page.workers,entries));},[page,entries,session,onTasks]);
 useEffect(()=>{
  // A hidden window / reconnect suspends transport, not the conversation.
  // Clearing history there repeatedly collapses the scroll height and island.
  setPage(null);setEntries([]);setError('');cursor.current='';hasOlder.current=false;
 },[session]);
 useEffect(()=>{
  const current=++generation.current,controller=new AbortController();let busy=false;
  if(!connected)return;
  const refresh=async()=>{
   if(busy)return;busy=true;
   try{const next=await api.specialistChannel(session,'',controller.signal);if(current!==generation.current)return;
    setPage(next);setEntries(old=>mergeChannelPage(old,next));setError('');if(!hasOlder.current)cursor.current=next.nextCursor;
   }catch(reason){if(!controller.signal.aborted&&current===generation.current)setError(readableError(reason));}finally{busy=false;}
  };
  void refresh();const timer=window.setInterval(()=>void refresh(),1000);
  return()=>{controller.abort();window.clearInterval(timer);};
 },[session,connected]);
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
 const name=page?.channel.roleName??snapshot.session.title;
 return <ObjectReferencesProvider resources={snapshot.resources}><div className="ai-transcript specialist-channel" data-reply-avatar="hidden">
  {!!cursor.current&&<button type="button" className="button secondary" disabled={loading} onClick={()=>void loadOlder()}>{loading?'正在加载…':'加载更早记录'}</button>}
  {error&&<p className="pilot-workspace-error" role="alert">{error}</p>}
  <SpecialistChannelEntries entries={entries} resources={snapshot.resources} workers={page?.workers} activeSources={new Set(connected?page?.active.map(active=>active.session.id)??[]:[])} activeSnapshots={new Map(page?.active.map(active=>[active.session.id,active])??[])}/>
  {(page?.routing||admitting||!!page?.queued)&&<div className="reply-duration turn-status is-live is-thinking without-avatar" role="status" aria-label="专员正在处理消息"><LoadingWaves/><StatusText active>正在安排工作</StatusText></div>}
  {page?.active.map(active=>{
   const task=active.superagent?.task;
   const cards=active.ai?.cards.filter(card=>!!active.ai?.turnStartedAt&&card.at>=active.ai.turnStartedAt)??[];
   const live={...active,messages:[],ai:active.ai?{...active.ai,cards,cardsOffset:0,totalCards:cards.length}:undefined};
   return <section className="specialist-channel-active" key={active.session.id} aria-label={task?.title??'当前任务'}>
    <AITranscript snapshot={live} proseInChannel superTask={task} assistantIdentity={{name}} disabled={!connected} refresh={()=>api.snapshot(active.session.id)} onInspect={()=>onTask(active.session.id)}/>
    <SpecialistTaskControls snapshot={active} connected={connected}/>
   </section>;
  })}
 </div></ObjectReferencesProvider>;
}
