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

export function mergeChannelEntries(previous:SpecialistChannelEntry[],incoming:SpecialistChannelEntry[]){
 const entries=new Map(previous.map(entry=>[entry.id,entry]));
 for(const entry of incoming)entries.set(entry.id,entry);
 return [...entries.values()].sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));
}

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

export function SpecialistChannelEntries({entries,resources}:{entries:SpecialistChannelEntry[];resources:SessionSnapshot['resources']}){
 return <>{entries.filter(entry=>!isCompactionFallbackEntry(entry)).map(entry=><div className="specialist-channel-entry" key={entry.id} data-source-session={entry.sourceSessionId} data-task-id={entry.taskId}>
  {entry.message?<TranscriptMessage message={entry.message} sessionId={entry.sourceSessionId} resources={resources} hideIdentity/>:entry.card?<Card card={entry.card}/>:null}
 </div>)}</>;
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
    setPage(next);setEntries(old=>mergeChannelEntries(old,next.entries));setError('');if(!hasOlder.current)cursor.current=next.nextCursor;
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
  <SpecialistChannelEntries entries={entries} resources={snapshot.resources}/>
  {(page?.routing||admitting||!!page?.queued)&&<div className="reply-duration turn-status is-live is-thinking without-avatar" role="status" aria-label="专员正在处理消息"><span className="turn-thinking-bubble"><span className="turn-thinking-dots" aria-hidden="true"><i/><i/><i/></span><span className="visually-hidden">正在安排工作</span></span></div>}
  {page?.active.map(active=>{
   const task=active.superagent?.task;
   const cards=active.ai?.cards.filter(card=>!!active.ai?.turnStartedAt&&card.at>=active.ai.turnStartedAt)??[];
   const live={...active,messages:[],ai:active.ai?{...active.ai,cards,cardsOffset:0,totalCards:cards.length}:undefined};
   return <section className="specialist-channel-active" key={active.session.id} aria-label={task?.title??'当前任务'}>
    <AITranscript snapshot={live} superTask={task} assistantIdentity={{name}} disabled={!connected} refresh={()=>api.snapshot(active.session.id)} onInspect={()=>onTask(active.session.id)}/>
    <SpecialistTaskControls snapshot={active} connected={connected}/>
   </section>;
  })}
 </div></ObjectReferencesProvider>;
}
