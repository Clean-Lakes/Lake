import {memo,useCallback,useEffect,useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import type {SessionEvent,SessionSnapshot,SpecialistReplyAuthor} from '../../shared/contracts';
import {api} from './api';
import {applyExternalReplyStageUpdate,applyLiveText} from './liveTextUpdates';
import {acceptSnapshot} from './snapshotUpdates';
import {awaitingPilotReport,pilotSpecialistBinding,pilotSpecialistPresentation,pilotToolStageLabel,specialistSnapshotMatches,type PilotReplyPresentation,type PilotReplyStage,type PilotSpecialistRow} from './pilotSpecialistReplies';
import {ReplyIdentity} from './ReplyIdentity';
import {AssistantMarkdown} from './AssistantMarkdown';
import {ReplyProcessStatus} from './ReplyProcessStatus';
import {usePageVisible} from './usePageVisible';
import {conversationPlanEntry} from './planConversation';
import {PlanReference,planMarkdown} from './PlanMode';
import {MessageAttachments} from './MessageAttachments';
import {SpecialistProcessLink} from './SpecialistProcessLink';
import type {InspectSpecialist} from './SessionInspectorContext';
import {allowsAnimalThinking,turnStatus} from './turnStatus';
import {useSpecialistAppearance} from './SuperRoleAvatar';
import {lakeAvatarThinking} from './lakeAvatarThinking';
import {LiveTextMotionLabel} from './liveTextMotion';
import {PilotReplyContent,PILOT_REPLY_TRANSITION_MS,type PilotReplyContentState} from './PilotReplyContent';
import {Glyph} from './Icons';
import {specialistInterimText} from './SpecialistReplyCursor';
import type {LakeAvatarName} from './lakeAvatarCatalog';
import type {SubscribePilotWorkerEvents} from './PilotWorkspace';

export async function loadPilotSpecialistSnapshot(row:PilotSpecialistRow,signal?:AbortSignal){
 // Task-scoped inspector snapshots replace the SDK invocation root with the
 // task's origin root. Live prose needs the current invocation and exact owner.
 const snapshot=await api.snapshot(row.worker.sessionId,signal);
 return specialistSnapshotMatches(row,snapshot)?snapshot:undefined;
}

/** Settled, delivered slots stay retired without polling their worker forever. */
export function shouldSubscribePilotReply(row:PilotSpecialistRow){
 return !(row.continuity==='terminal'&&(row.finalReport||row.observedRootTurnId&&row.reportedTurns.includes(row.observedRootTurnId)));
}

function useSpecialistReply(row:PilotSpecialistRow,connected:boolean,visible:boolean,subscribeWorkerEvents?:SubscribePilotWorkerEvents){
 const binding=pilotSpecialistBinding(row),subscribe=shouldSubscribePilotReply(row);
 const [state,setState]=useState<{binding:string;snapshot?:SessionSnapshot;failed:boolean;livePacket?:boolean}>();
 useEffect(()=>{
  if(!connected||!visible||!subscribe)return;
  const controller=new AbortController();let disposed=false,busy=false,queued=false,healthy=false,streamOpen=false;
  let latest=state?.binding===binding?state.snapshot:undefined,frame:number|undefined,timer:ReturnType<typeof setTimeout>|undefined,stream:EventSource|undefined;
  let snapshotFailureSince:number|undefined;
  let frameHasActivity=false;
  const refresh=async()=>{
   if(busy){queued=true;return;}busy=true;
   try{
    const next=await loadPilotSpecialistSnapshot(row,AbortSignal.any([controller.signal,AbortSignal.timeout(12000)]));
    if(disposed)return;
    snapshotFailureSince=undefined;
    healthy=streamOpen;
    // A response for a superseded binding cannot replace this row's prose.
    if(next&&(!latest||next.cursor>=latest.cursor)){
     if(next.ai?.rootTurnId!==latest?.ai?.rootTurnId)frameHasActivity=false;
     latest=acceptSnapshot(latest??null,next);
    }
    const snapshot=latest;
    if(frame===undefined)setState(current=>current?.binding===binding&&current.snapshot===snapshot&&!current.failed?current:{binding,snapshot,failed:false});
   }catch{
    if(disposed)return;
    healthy=false;
    const now=Date.now();
    snapshotFailureSince??=now;
    if(now-snapshotFailureSince>=1500)setState({binding,snapshot:latest,failed:true});
   }
   finally{busy=false;if(queued&&!disposed){queued=false;void refresh();}}
  };
  const schedule=()=>{if(!timer)timer=setTimeout(()=>{timer=undefined;void refresh();},100);};
  const receive=(event:SessionEvent)=>{
   try{
    if(event.sessionId!==row.worker.sessionId||!Number.isSafeInteger(event.seq)||latest&&event.seq<=latest.cursor)return;
    const next=event.externalReplyStageUpdate?applyExternalReplyStageUpdate(latest??null,event):event.textUpdate?applyLiveText(latest??null,event):null;
    if(next){
     latest=next;frameHasActivity||=!!(event.textUpdate||event.externalReplyStageUpdate);
     if(frame===undefined)frame=requestAnimationFrame(()=>{
      frame=undefined;if(disposed)return;
      const snapshot=latest,hasActivity=frameHasActivity;
      frameHasActivity=false;snapshotFailureSince=undefined;
      healthy=streamOpen;
      setState(current=>({binding,snapshot,failed:false,livePacket:hasActivity||
       current?.binding===binding&&current.snapshot?.ai?.rootTurnId===snapshot?.ai?.rootTurnId&&current.livePacket}));
     });
    }else schedule();
   }catch{schedule();}
  };
  const connection=(open:boolean)=>{streamOpen=open;healthy=open;if(open)void refresh();};
  const unsubscribe=subscribeWorkerEvents?.(row.worker.sessionId,{receive,connection});
  if(!busy)void refresh();
  if(!subscribeWorkerEvents&&typeof EventSource!=='undefined'){
   stream=new EventSource(api.eventsUrl(row.worker.sessionId,latest?.cursor??0),{withCredentials:true});
   const receiveMessage=(incoming:MessageEvent<string>)=>{
    try{receive(JSON.parse(incoming.data));}catch{schedule();}
   };
   stream.onopen=()=>connection(true);
   stream.onerror=()=>{connection(false);void refresh();};
   stream.onmessage=receiveMessage;
   for(const type of ['session','specialist'])stream.addEventListener(type,receiveMessage as EventListener);
  }
  const poll=setInterval(()=>{if(!healthy)void refresh();},2000);
  return()=>{disposed=true;controller.abort();unsubscribe?.();stream?.close();clearInterval(poll);if(timer)clearTimeout(timer);if(frame!==undefined)cancelAnimationFrame(frame);};
 },[binding,connected,visible,subscribe,subscribeWorkerEvents]);
 return state?.binding===binding?state:undefined;
}

type ObservedTurn=(row:PilotSpecialistRow,root:string)=>void;
type ReportPresented=(id:string)=>void;

function PilotSpecialistReply({row,onSpecialist,onInspectSpecialist,connected,onObservedTurn,onReportPresented,taskLabel,subscribeWorkerEvents}:{row:PilotSpecialistRow;onSpecialist?: (author:SpecialistReplyAuthor)=>void;onInspectSpecialist?:InspectSpecialist;connected:boolean;onObservedTurn?:ObservedTurn;onReportPresented?:ReportPresented;taskLabel?:string;subscribeWorkerEvents?:SubscribePilotWorkerEvents}){
 const visible=usePageVisible(),state=useSpecialistReply(row,connected,visible,subscribeWorkerEvents);
 return <PilotSpecialistReplyView row={row} snapshot={state?.snapshot} livePacket={state?.livePacket} available={connected&&!state?.failed} visible={visible} onSpecialist={onSpecialist} onInspectSpecialist={onInspectSpecialist} onObservedTurn={onObservedTurn} onReportPresented={onReportPresented} taskLabel={taskLabel}/>;
}

const PilotReplyProse=memo(function PilotReplyProse({text,active,animateInitial,cursorAvatar}:{text:string;active:boolean;animateInitial?:boolean;cursorAvatar?:LakeAvatarName}){
 return <div className="ai-card ai-message"><AssistantMarkdown reveal={active} animateInitial={animateInitial} cursorAvatar={cursorAvatar}>{text}</AssistantMarkdown></div>;
});

function PilotReplyStageSurface({stage,arrive,active,children}:{stage:PilotReplyStage;arrive:boolean;active:boolean;children:ReactNode}){
 const element=useRef<HTMLDivElement>(null),entering=useRef(arrive);
 useLayoutEffect(()=>{
  if(!entering.current)return;
  entering.current=false;
  if(!active||document.hidden||window.matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  const animation=element.current?.animate?.([{clipPath:'inset(0 100% 0 0)',opacity:.45},{clipPath:'inset(0 0 0 0)',opacity:1}],
   {duration:stage.kind==='tools'?320:PILOT_REPLY_TRANSITION_MS,easing:'cubic-bezier(.22,1,.36,1)'});
  return()=>animation?.cancel();
 },[active,stage.kind]);
 return <div ref={element} className="pilot-specialist-stage" data-reply-stage={stage.kind} data-reply-stage-id={stage.id}>{children}</div>;
}

function PilotToolStage({stage,active}:{stage:Extract<PilotReplyStage,{kind:'tools'}>;active:boolean}){
 const label=pilotToolStageLabel(stage.progress,active,stage.action);
 const row=useRef<HTMLDivElement>(null),previous=useRef({label,active});
 useLayoutEffect(()=>{
  const last=previous.current;
  previous.current={label,active};
  if(!active||!last.active||last.label===label||document.hidden||window.matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  const animation=row.current?.animate?.([{opacity:.6},{opacity:1}],{duration:240,easing:'ease-out'});
  return()=>animation?.cancel();
 },[label,active]);
 return <div ref={row} className="pilot-specialist-tool-stage"><Glyph name="plug" size={13}/><ReplyProcessStatus active={active&&stage.progress.running>0}>{label}</ReplyProcessStatus></div>;
}

type PlanOptions=Parameters<typeof conversationPlanEntry>[1];
function PilotReplyStages({stages,text,active,arrive,cursorAvatar,plan}:{stages:PilotReplyStage[];text:string;active:boolean;arrive:boolean;cursorAvatar?:LakeAvatarName;plan:PlanOptions}){
 const currentProse=stages.filter(stage=>stage.kind==='prose').at(-1);
 return <div className="pilot-specialist-stages">{stages.map(stage=>{
  let content;
  if(stage.kind==='tools'){
   content=<PilotToolStage stage={stage} active={active}/>;
  }else{
   const current=stage===currentProse;
   const projected=conversationPlanEntry({id:stage.card.id,at:stage.card.at,card:stage.card},{...plan,live:plan.live&&current});
   content=projected.card?.type==='plan_reference'
    ?<PlanReference state={(projected.card.data as {state:'saved'|'writing'|'incomplete'}).state}/>
    :<PilotReplyProse text={current?text:stage.card.content??''} active={active&&current} animateInitial={arrive&&current} cursorAvatar={current?cursorAvatar:undefined}/>;
  }
  return <PilotReplyStageSurface key={stage.id} stage={stage} arrive={arrive} active={active}>{content}</PilotReplyStageSurface>;
 })}</div>;
}

/** Public reply presentation is separate from the exact-worker live subscription. */
export function PilotSpecialistReplyView({row,snapshot,livePacket,available=true,visible=true,onSpecialist,onInspectSpecialist,onObservedTurn,onReportPresented,taskLabel}:{row:PilotSpecialistRow;snapshot?:SessionSnapshot;livePacket?:boolean;available?:boolean;visible?:boolean;onSpecialist?:(author:SpecialistReplyAuthor)=>void;onInspectSpecialist?:InspectSpecialist;onObservedTurn?:ObservedTurn;onReportPresented?:ReportPresented;taskLabel?:string}){
 const appearance=useSpecialistAppearance(row.author);
 const previous=useRef<PilotReplyPresentation&{observed:boolean}>(undefined),binding=pilotSpecialistBinding(row);
 const entry=pilotSpecialistPresentation(row,snapshot,previous.current);
 const awaitingReport=awaitingPilotReport(row,snapshot);
 const statusSnapshot=snapshot&&specialistSnapshotMatches(row,snapshot)&&(!row.continuity||!!row.observedRootTurnId&&snapshot.ai?.rootTurnId===row.observedRootTurnId)?snapshot:undefined;
 const observed=previous.current?.binding===binding&&previous.current.observed;
 useLayoutEffect(()=>{previous.current={binding,entry,observed:observed||!!statusSnapshot};});
 const status=statusSnapshot?.ai?turnStatus(undefined,statusSnapshot.ai,statusSnapshot.ai.cards,statusSnapshot.ai.turnStartedAt??row.sourceCreatedAt,Date.now()):undefined;
 const candidate=row.finalReport;
 const report=candidate&&(!entry?.reply?.turnId||entry.reply.turnId===candidate.author?.rootTurnId||
  candidate.id===row.worker.pilotReport?.messageId||candidate.replyToMessageId===row.sourceMessageId&&Date.parse(candidate.createdAt)>=Date.parse(entry.createdAt))?candidate:undefined;
 const executing=row.activity.phase==='thinking'||row.activity.phase==='tool';
 // The worker can finish before the workspace learns that its report is pending.
 const working=!report&&available&&status?.phase!=='waiting'&&
  (awaitingReport?(executing||!!row.worker.pilotReport):executing&&
    (status?.phase!=='settled'||status.state==='回复结束'));
 const workedBinding=useRef('');
 useLayoutEffect(()=>{if(working)workedBinding.current=binding;},[working,binding]);
 const [presented,setPresented]=useState('');
 const reportPresented=useCallback((id:string)=>{setPresented(id);onReportPresented?.(id);},[onReportPresented]);
 const moving=working||!!report&&available&&presented!==report.id&&workedBinding.current===binding;
 const plan={planMode:snapshot?.conversationMode==='plan',live:moving,currentPlanId:snapshot?.ai?.proposedPlan?.id};
 const reportEntry=report?conversationPlanEntry({id:report.id,at:report.createdAt,message:report},{...plan,live:false}):undefined;
 const projected=reportEntry??(entry?.card?conversationPlanEntry({id:entry.card.id,at:entry.createdAt,card:entry.card},plan):undefined);
 const text=projected?.card?.type==='plan_reference'?'':report?planMarkdown(report.text):
  specialistInterimText(entry?.card?.content??'');
 useLayoutEffect(()=>{
  if(entry?.reply?.turnId)onObservedTurn?.(row,entry.reply.turnId);
 },[entry?.reply?.turnId,onObservedTurn,row]);
 const observedRoot=entry?.reply?.turnId??row.observedRootTurnId;
 if(!report&&observedRoot&&row.reportedTurns.includes(observedRoot))return null;
 const thinking=moving&&row.activity.phase==='thinking'&&allowsAnimalThinking(snapshot?.ai)&&(!status||status.phase==='thinking')&&!text&&projected?.card?.type!=='plan_reference';
 const snapshotLabel=status&&(status.phase==='waiting'||status.phase==='settled'||row.activity.phase==='thinking'&&status.phase!=='thinking')?status.state:undefined;
 const updating=row.activity.phase==='updating';
 // A brief workspace gap must not hide a real question or failure. A terminal
 // workspace, however, owns its result handoff over a lagging live snapshot.
 const interruptionLabel=status&&(status.phase==='waiting'||status.phase==='settled'&&status.state!=='回复结束')?status.state:undefined;
 const label=available?(updating?(row.continuity==='terminal'?row.activity.label:interruptionLabel??row.activity.label):snapshotLabel??row.activity.label):'进度暂未更新，正在重连';
 const waitingLabel=status?.phase==='waiting'?status.state
  :['waiting_approval','waiting_input','waiting_external'].includes(row.activity.phase)?row.activity.label:undefined;
 const planState=projected?.card?.type==='plan_reference'?(projected.card.data as {state:'saved'|'writing'|'incomplete'}).state:undefined;
 const stages=report?undefined:entry?.stages;
 const hasStages=!!stages?.length;
 const inlineWait=(text||hasStages)&&available&&!report&&!awaitingReport&&!updating?waitingLabel:undefined;
 const live=working&&visible&&!awaitingReport;
 const contentState:PilotReplyContentState={
  binding,
  kind:hasStages?'stages':planState?'plan':text||report?'prose':'status',id:hasStages?entry?.reply?.turnId??'':report?.id??entry?.card?.id??'',
  text:planState??(report?text:text||(thinking?lakeAvatarThinking[appearance.icon].label:label)),
  live,
 };
 return <section className="ai-chat-message ai-role-assistant pilot-specialist-reply" data-worker-id={row.worker.id} data-task-id={row.worker.task.taskId} data-phase={report?'settled':row.activity.phase} data-report-id={report?.id} aria-label={`${row.author.name}的回复`}>
  <ReplyIdentity identity={{name:'Pilot',pilot:true}} author={report?.author??row.author} authorMotion={moving?'working':'still'} nameMotion={moving&&visible} onSpecialist={onSpecialist}/>
  {taskLabel&&<small className="pilot-specialist-task-label">{taskLabel}</small>}
  <PilotReplyContent state={contentState} onPresented={report?reportPresented:undefined} active={(moving||!!report&&!['failed','cancelled'].includes(row.worker.task.state))&&available&&visible}>
   {hasStages?<PilotReplyStages key={entry?.reply?.turnId} stages={stages!} text={text} active={live} arrive={live&&(observed||!!livePacket)} cursorAvatar={working?appearance.icon:undefined} plan={plan}/>:planState?<PlanReference state={planState}/>:text?<PilotReplyProse text={text} active={live} animateInitial={livePacket} cursorAvatar={working?appearance.icon:undefined}/>:report||awaitingReport?null:thinking?<ReplyProcessStatus><LiveTextMotionLabel active={moving&&visible} glow className="pilot-specialist-thinking-label">{lakeAvatarThinking[appearance.icon].label}</LiveTextMotionLabel></ReplyProcessStatus>:<ReplyProcessStatus active={moving&&visible}>{label}</ReplyProcessStatus>}
   {report&&<MessageAttachments message={report} sessionId={report.sessionId}/>}
  </PilotReplyContent>
  <SpecialistProcessLink author={report?.author??row.author} reportId={report?.id} onInspect={onInspectSpecialist} active={moving&&visible} liveStatus={inlineWait}/>
  {!report&&(text||hasStages)&&(!available||updating&&!awaitingReport)&&<small className="pilot-specialist-connection" role="status">{label}</small>}
 </section>;
}

export function PilotSpecialistConversation({rows,onSpecialist,onInspectSpecialist,connected=true,onObservedTurn,onReportPresented,taskLabels,subscribeWorkerEvents}:{rows:PilotSpecialistRow[];onSpecialist?: (author:SpecialistReplyAuthor)=>void;onInspectSpecialist?:InspectSpecialist;connected?:boolean;onObservedTurn?:ObservedTurn;onReportPresented?:ReportPresented;taskLabels?:ReadonlyMap<string,string>;subscribeWorkerEvents?:SubscribePilotWorkerEvents}){
 if(!rows.length)return null;
 return <div className="pilot-specialist-conversation">{rows.map(row=><PilotSpecialistReply key={row.worker.id} row={row} onSpecialist={onSpecialist} onInspectSpecialist={onInspectSpecialist} connected={connected} onObservedTurn={onObservedTurn} onReportPresented={onReportPresented} taskLabel={taskLabels?.get(row.worker.id)} subscribeWorkerEvents={subscribeWorkerEvents}/>)}</div>;
}
