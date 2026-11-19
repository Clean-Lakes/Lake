import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import type {SessionEvent,SessionSnapshot,SpecialistReplyAuthor} from '../../shared/contracts';
import {api} from './api';
import {applyLiveText} from './liveTextUpdates';
import {awaitingPilotReport,pilotSpecialistBinding,pilotSpecialistPresentation,specialistSnapshotMatches,type PilotReplyPresentation,type PilotSpecialistRow} from './pilotSpecialistReplies';
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
import {conversationActivity} from './superAgentPresentation';
import {useSpecialistAppearance} from './SuperRoleAvatar';
import {lakeAvatarThinking} from './lakeAvatarThinking';
import {LiveTextMotionLabel} from './liveTextMotion';
import {PilotReplyContent,type PilotReplyContentState} from './PilotReplyContent';

export async function loadPilotSpecialistSnapshot(row:PilotSpecialistRow,signal?:AbortSignal){
 // Task-scoped inspector snapshots replace the SDK invocation root with the
 // task's origin root. Live prose needs the current invocation and exact owner.
 const snapshot=await api.snapshot(row.worker.sessionId,signal);
 return specialistSnapshotMatches(row,snapshot)?snapshot:undefined;
}

/** Settled, delivered slots stay retired without polling their worker forever. */
export function shouldSubscribePilotReply(row:PilotSpecialistRow){
 return !(row.continuity==='terminal'&&row.observedRootTurnId&&row.reportedTurns.includes(row.observedRootTurnId));
}

function useSpecialistReply(row:PilotSpecialistRow,connected:boolean,visible:boolean){
 const binding=pilotSpecialistBinding(row),subscribe=shouldSubscribePilotReply(row);
 const [state,setState]=useState<{binding:string;snapshot?:SessionSnapshot;failed:boolean;livePacket?:boolean}>();
 useEffect(()=>{
  if(!connected||!visible||!subscribe)return;
  const controller=new AbortController();let disposed=false,busy=false,queued=false,healthy=false;
  let latest=state?.binding===binding?state.snapshot:undefined,frame:number|undefined,timer:ReturnType<typeof setTimeout>|undefined,stream:EventSource|undefined;
  let events:SessionEvent[]=[];
  const refresh=async()=>{
   if(busy){queued=true;return;}busy=true;
   try{
    const next=await loadPilotSpecialistSnapshot(row,controller.signal);
    if(disposed)return;
    if(!next){latest=undefined;setState({binding,failed:true});return;}
    if(!latest||next.cursor>=latest.cursor){latest=next;healthy=stream?.readyState===1;setState({binding,snapshot:next,failed:false});}
   }catch{if(!disposed){healthy=false;setState({binding,snapshot:latest,failed:true});}}
   finally{busy=false;if(queued&&!disposed){queued=false;void refresh();}}
  };
  const schedule=()=>{if(!timer)timer=setTimeout(()=>{timer=undefined;void refresh();},100);};
  const receive=(incoming:MessageEvent<string>)=>{
   try{
    const event=JSON.parse(incoming.data) as SessionEvent;
    if(event.sessionId!==row.worker.sessionId||typeof event.seq!=='number'||latest&&event.seq<=latest.cursor)return;
    if(event.textUpdate&&applyLiveText(latest??null,event)){
     events.push(event);
     if(frame===undefined)frame=requestAnimationFrame(()=>{
      frame=undefined;if(disposed)return;
      for(const item of events)latest=applyLiveText(latest??null,item)??latest;
      events=[];setState({binding,snapshot:latest,failed:false,livePacket:true});
     });
    }else schedule();
   }catch{schedule();}
  };
  void refresh();
  stream=typeof EventSource==='undefined'?undefined:new EventSource(api.eventsUrl(row.worker.sessionId,latest?.cursor??0),{withCredentials:true});
  if(stream){
   stream.onopen=()=>{healthy=true;void refresh();};
   stream.onerror=()=>{healthy=false;setState({binding,snapshot:latest,failed:true});void refresh();};
   stream.onmessage=receive;
   for(const type of ['session','specialist'])stream.addEventListener(type,receive as EventListener);
  }
  const poll=setInterval(()=>{if(!healthy)void refresh();},2000);
  return()=>{disposed=true;controller.abort();stream?.close();clearInterval(poll);if(timer)clearTimeout(timer);if(frame!==undefined)cancelAnimationFrame(frame);};
 },[binding,connected,visible,subscribe]);
 return state?.binding===binding?state:undefined;
}

type ObservedTurn=(row:PilotSpecialistRow,root:string)=>void;
type ReportPresented=(id:string)=>void;

function PilotSpecialistReply({row,onSpecialist,onInspectSpecialist,connected,onObservedTurn,onReportPresented}:{row:PilotSpecialistRow;onSpecialist?: (author:SpecialistReplyAuthor)=>void;onInspectSpecialist?:InspectSpecialist;connected:boolean;onObservedTurn?:ObservedTurn;onReportPresented?:ReportPresented}){
 const visible=usePageVisible(),state=useSpecialistReply(row,connected,visible);
 return <PilotSpecialistReplyView row={row} snapshot={state?.snapshot} livePacket={state?.livePacket} available={connected&&!state?.failed} visible={visible} onSpecialist={onSpecialist} onInspectSpecialist={onInspectSpecialist} onObservedTurn={onObservedTurn} onReportPresented={onReportPresented}/>;
}

function PilotReplyProse({text,active,animateInitial}:{text:string;active:boolean;animateInitial?:boolean}){
 return <div className="ai-card ai-message"><AssistantMarkdown reveal={active} animateInitial={animateInitial}>{text}</AssistantMarkdown></div>;
}

/** Public reply presentation is separate from the exact-worker live subscription. */
export function PilotSpecialistReplyView({row,snapshot,livePacket,available=true,visible=true,onSpecialist,onInspectSpecialist,onObservedTurn,onReportPresented}:{row:PilotSpecialistRow;snapshot?:SessionSnapshot;livePacket?:boolean;available?:boolean;visible?:boolean;onSpecialist?:(author:SpecialistReplyAuthor)=>void;onInspectSpecialist?:InspectSpecialist;onObservedTurn?:ObservedTurn;onReportPresented?:ReportPresented}){
 const appearance=useSpecialistAppearance(row.author);
 const previous=useRef<PilotReplyPresentation>(undefined),binding=pilotSpecialistBinding(row);
 const entry=pilotSpecialistPresentation(row,snapshot,previous.current);
 useLayoutEffect(()=>{previous.current={binding,entry};});
 const awaitingReport=awaitingPilotReport(row,snapshot);
 const statusSnapshot=snapshot&&specialistSnapshotMatches(row,snapshot)&&(!row.continuity||!!row.observedRootTurnId&&snapshot.ai?.rootTurnId===row.observedRootTurnId)?snapshot:undefined;
 const status=statusSnapshot?.ai?turnStatus(undefined,statusSnapshot.ai,statusSnapshot.ai.cards,statusSnapshot.ai.turnStartedAt??row.sourceCreatedAt,Date.now()):undefined;
 const report=row.finalReport&&(!entry?.reply?.turnId||entry.reply.turnId===row.finalReport.author?.rootTurnId)?row.finalReport:undefined;
 const moving=!report&&!awaitingReport&&available&&['thinking','tool'].includes(row.activity.phase)&&(!snapshot||conversationActivity(snapshot.ai)==='running')&&(!status||!['waiting','settled'].includes(status.phase));
 const reportEntry=report?conversationPlanEntry({id:report.id,at:report.createdAt,message:report},{planMode:snapshot?.conversationMode==='plan',live:false,currentPlanId:snapshot?.ai?.proposedPlan?.id}):undefined;
 const projected=reportEntry??(entry?.card?conversationPlanEntry({id:entry.card.id,at:entry.createdAt,card:entry.card},{planMode:snapshot?.conversationMode==='plan',live:moving,currentPlanId:snapshot?.ai?.proposedPlan?.id}):undefined);
 const text=projected?.card?.type==='plan_reference'?'':report?planMarkdown(report.text):entry?.card?.content??'';
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
 const inlineWait=text&&available&&!report&&!awaitingReport&&!updating?waitingLabel:undefined;
 const planState=projected?.card?.type==='plan_reference'?(projected.card.data as {state:'saved'|'writing'|'incomplete'}).state:undefined;
 const contentState:PilotReplyContentState={
  binding:pilotSpecialistBinding(row),
  kind:planState?'plan':text||report?'prose':'status',id:report?.id??entry?.card?.id??'',
  text:planState??(report?text:text||(thinking?lakeAvatarThinking[appearance.icon].label:label)),
  live:moving&&visible,
 };
 return <section className="ai-chat-message ai-role-assistant pilot-specialist-reply" data-worker-id={row.worker.id} data-task-id={row.worker.task.taskId} data-phase={report?'settled':row.activity.phase} data-report-id={report?.id} aria-label={`${row.author.name}的回复`}>
  <ReplyIdentity identity={{name:'Pilot',pilot:true}} author={report?.author??row.author} authorMotion={moving?'working':'still'} nameMotion={moving&&visible} onSpecialist={onSpecialist}/>
  <PilotReplyContent state={contentState} onPresented={report?onReportPresented:undefined} active={(moving||!!report&&!['failed','cancelled'].includes(row.worker.task.state))&&available&&visible}>
   {planState?<PlanReference state={planState}/>:text?<PilotReplyProse text={text} active={moving&&visible} animateInitial={livePacket}/>:report||awaitingReport?null:thinking?<ReplyProcessStatus><LiveTextMotionLabel active={moving&&visible} glow className="pilot-specialist-thinking-label">{lakeAvatarThinking[appearance.icon].label}</LiveTextMotionLabel></ReplyProcessStatus>:<ReplyProcessStatus active={moving&&visible}>{label}</ReplyProcessStatus>}
   {report&&<MessageAttachments message={report} sessionId={report.sessionId}/>}
  </PilotReplyContent>
  <SpecialistProcessLink author={report?.author??row.author} reportId={report?.id} onInspect={onInspectSpecialist} active={moving&&visible} liveStatus={inlineWait}/>
  {!report&&text&&(!available||updating&&!awaitingReport)&&<small className="pilot-specialist-connection" role="status">{label}</small>}
 </section>;
}

export function PilotSpecialistConversation({rows,onSpecialist,onInspectSpecialist,connected=true,onObservedTurn,onReportPresented}:{rows:PilotSpecialistRow[];onSpecialist?: (author:SpecialistReplyAuthor)=>void;onInspectSpecialist?:InspectSpecialist;connected?:boolean;onObservedTurn?:ObservedTurn;onReportPresented?:ReportPresented}){
 if(!rows.length)return null;
 return <div className="pilot-specialist-conversation">{rows.map(row=><PilotSpecialistReply key={row.worker.id} row={row} onSpecialist={onSpecialist} onInspectSpecialist={onInspectSpecialist} connected={connected} onObservedTurn={onObservedTurn} onReportPresented={onReportPresented}/>)}</div>;
}
