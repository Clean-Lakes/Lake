import {createPortal} from 'react-dom';
import {sessionInspectorId,useSessionInspector,type InspectorSelection} from './SessionInspectorContext';
import {createContext,useId,useState,type ReactNode} from 'react';
import {ReplyDuration,type ReplyDurationProps} from './ReplyDuration';
import {ReplyFooter,ReplyProcessContext} from './ReplyFooter';
import {replyElapsed} from './replyDurationState';
import {turnStatus} from './turnStatus';
import {quietCoordination} from './coordinationActivity';
import {recoveredRouteFailures} from './routeDispatchPresentation';
import {DisclosureSummary} from './DisclosureSummary';
export const ExecutionDetailsOpen=createContext(false);
export const RoutingRecoveryContext=createContext<ReadonlySet<string>>(new Set());
export function canonicalExecutionSelected(selection:InspectorSelection|null|undefined,sessionId:string,canonicalGoalId:string){
 return selection?.sessionId===sessionId&&selection.canonicalGoalId===canonicalGoalId&&selection.tab==='execution';
}
export function TurnExecutionDetails({details,onInspect,presentingReply=false,hideLive=false,hideStatus=false,hideIdentity:_hideIdentity=false,sessionId,latest=false,latestTaskId,canonicalGoalId,detailsInHeader=false,children,specialistReplies,collaboration,footerReportId,pilotOverview,progress:_progress,...timing}:{hideStatus?:boolean;hideIdentity?:boolean;latest?:boolean;latestTaskId?:string;canonicalGoalId?:string;detailsInHeader?:boolean;progress?:{text:string;active:boolean};hideLive?:boolean;sessionId?:string;children?:ReactNode;specialistReplies?:ReactNode;collaboration?:(footer:ReactNode)=>ReactNode;footerReportId?:string;pilotOverview?:ReactNode;details:ReactNode[];onInspect?:()=>void;presentingReply?:boolean}&ReplyDurationProps){
 const id=useId();
 const inspector=useSessionInspector();
 const selection=inspector?.selection;
 const showOverview=selection?.view==='pilot-activity';
 const inspecting=!!selection&&selection.sessionId===sessionId&&
  (showOverview?latest&&!!pilotOverview:selection.followLatest?latest&&!latestTaskId:selection.tab==='execution'&&selection.turnId===id);
 const {live,phase,duration,state}=turnStatus(timing.timing,timing.view,timing.cards??[],timing.latestUserAt??'',Date.now());
 const [replyClock,setReplyClock]=useState({presenting:presentingReply,at:Date.now()});
 if(replyClock.presenting!==presentingReply)setReplyClock({presenting:presentingReply,at:Date.now()});
 // A completed view can arrive before its final timing record. Keep the
 // conclusion footer in place while that record catches up.
 const preview=live&&presentingReply&&!hideLive&&(phase==='streaming'||state==='回复结束');
 // Detail visibility belongs to the reader, never to a streaming/status update.
 const [open,setOpen]=useState(false);
 const recoveredRouting=recoveredRouteFailures(timing.cards??[]);
 const livePilot=live&&timing.assistantIdentity?.pilot;
 const latestStep=livePilot?undefined:timing.cards?.filter(card=>['operation','shell'].includes(card.type)&&!quietCoordination(card)&&!recoveredRouting.has(card.id)).at(-1);
 const summaryDisclosure=details.length||canonicalGoalId?{open:inspector&&sessionId?canonicalGoalId?canonicalExecutionSelected(selection,sessionId,canonicalGoalId):inspecting:open,controls:inspector&&sessionId?sessionInspectorId:id,side:!!(inspector&&sessionId),onToggle:()=>{
  if(inspector&&sessionId)inspector.open(canonicalGoalId?{sessionId,canonicalGoalId,tab:'execution'}:{sessionId,turnId:id,tab:'execution'});
  else {onInspect?.();setOpen(!open);}
 }}:undefined;
 // The status island can replace the live disclosure only when its target
 // opens these same records. Other turns keep their own disclosure.
 const inlineDisclosure=livePilot&&detailsInHeader&&latest&&inspector&&sessionId?undefined:summaryDisclosure;
 const liveNotice=livePilot?undefined:timing.detailNotice;
 const settledStatus=state==='回复结束'?undefined:state;
 const foldFailure=!!summaryDisclosure&&settledStatus==='未完成';
 const pilot=timing.assistantIdentity?.pilot&&inspector&&sessionId&&summaryDisclosure?{sessionId,turnId:id,canonicalGoalId}:undefined;
 const combinedReportId=!live&&(pilot||!summaryDisclosure)?footerReportId:undefined;
 const footerStatus=foldFailure?undefined:settledStatus;
 const footerDuration=preview&&timing.timing?replyElapsed(timing.timing,replyClock.at):duration;
 const summary=live&&!preview?<ReplyDuration {...timing} latestStep={latestStep} detailNotice={liveNotice} disclosure={inlineDisclosure}/>
  :!combinedReportId&&<ReplyFooter preview={preview} status={preview?liveNotice:footerStatus} duration={summaryDisclosure||!timing.assistantIdentity?.pilot?footerDuration:undefined} action={inlineDisclosure&&{
   text:timing.processLabel,controls:inlineDisclosure.controls,expanded:inlineDisclosure.open,side:inlineDisclosure.side,onClick:inlineDisclosure.onToggle
  }}/>;
 const notice=[foldFailure?settledStatus:undefined,timing.detailNotice].filter(Boolean).join(' · ');
 const records=<>{notice&&<p className="execution-detail-note">{notice}</p>}{details.length?details:<p className="inspector-empty">本轮尚无执行记录。</p>}</>;
 const overviewBody=showOverview&&inspecting&&inspector?.host&&createPortal(<>
  {pilotOverview}
  {(details.length>0||notice)&&<details className="pilot-execution-records"><DisclosureSummary>完整执行记录</DisclosureSummary>
   <ExecutionDetailsOpen.Provider value={true}><div className="inspector-turn-details">{records}</div></ExecutionDetailsOpen.Provider>
  </details>}
 </>,inspector.host);
 const body=showOverview?overviewBody:canonicalGoalId?null:inspector&&sessionId?inspecting&&inspector.host&&createPortal(<ExecutionDetailsOpen.Provider value={true}><div className="inspector-turn-details">{records}</div></ExecutionDetailsOpen.Provider>,inspector.host)
  :details.length>0&&<div id={id} className={`turn-execution-details${open?' is-open':''}`} aria-hidden={!open} inert={!open} role="region" aria-label="执行详细过程"><div className="turn-execution-content"><div className="turn-execution-body"><ExecutionDetailsOpen.Provider value={open}>{records}</ExecutionDetailsOpen.Provider></div></div></div>;
 const footer=!hideStatus&&(!live||!hideLive)&&summary;
 return <RoutingRecoveryContext.Provider value={recoveredRouting}><ReplyProcessContext.Provider value={{pilot,footer:combinedReportId?{reportId:combinedReportId,status:footerStatus}:undefined}}>
  {children}{(!collaboration||live)&&footer}{specialistReplies}{collaboration?.(live?undefined:footer)}
 </ReplyProcessContext.Provider>{body}</RoutingRecoveryContext.Provider>;
}
