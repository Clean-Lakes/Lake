import {createPortal} from 'react-dom';
import {sessionInspectorId,useSessionInspector,type InspectorSelection} from './SessionInspectorContext';
import {createContext,useId,useState,type ReactNode} from 'react';
import {ReplyDuration,type ReplyDurationProps} from './ReplyDuration';
import {ReplyFooter,ReplyProcessContext} from './ReplyFooter';
import {replyElapsed} from './replyDurationState';
import {turnStatus} from './turnStatus';
import {quietCoordination} from './coordinationActivity';
import {recoveredRouteFailures} from './routeDispatchPresentation';
export const ExecutionDetailsOpen=createContext(false);
export const RoutingRecoveryContext=createContext<ReadonlySet<string>>(new Set());
export function canonicalExecutionSelected(selection:InspectorSelection|null|undefined,sessionId:string,canonicalGoalId:string){
 return selection?.sessionId===sessionId&&selection.canonicalGoalId===canonicalGoalId&&selection.tab==='execution';
}
export function TurnExecutionDetails({details,processNotices,onInspect,presentingReply=false,hideLive=false,hideStatus=false,hideIdentity:_hideIdentity=false,sessionId,latest=false,latestTaskId,canonicalGoalId,compactLiveStatus=false,children,specialistReplies,collaboration,footerReportId,progress:_progress,...timing}:{hideStatus?:boolean;hideIdentity?:boolean;latest?:boolean;latestTaskId?:string;canonicalGoalId?:string;compactLiveStatus?:boolean;progress?:{text:string;active:boolean};hideLive?:boolean;sessionId?:string;children?:ReactNode;specialistReplies?:ReactNode;collaboration?:(footer:ReactNode)=>ReactNode;footerReportId?:string;details:ReactNode[];processNotices?:readonly {status:string;label:string}[];onInspect?:()=>void;presentingReply?:boolean}&ReplyDurationProps){
 const id=useId();
 const inspector=useSessionInspector();
 const selection=inspector?.selection;
 // Keep the recorded turn mounted while the inert pane slides out.
 const displayed=selection??(inspector?.host?inspector.lastSelection:null);
 const showRecords=!!displayed&&displayed.sessionId===sessionId&&
  (displayed.followLatest?latest&&!latestTaskId:displayed.tab==='execution'&&displayed.turnId===id);
 const inspecting=!!selection&&showRecords;
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
 const inlineDisclosure=livePilot&&compactLiveStatus&&latest&&inspector&&sessionId?undefined:summaryDisclosure;
 const liveNotice=livePilot?undefined:processNotices?.map(notice=>notice.label).join(' · ')??timing.detailNotice;
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
 const detailNotice=processNotices?.map(item=>item.label).join(' · ')??timing.detailNotice;
 const notice=[foldFailure?settledStatus:undefined,detailNotice].filter(Boolean).join(' · ');
 const records=<>{notice&&<p className="execution-detail-note">{notice}</p>}{details.length?details:<p className="inspector-empty">本轮尚无执行记录。</p>}</>;
 const body=canonicalGoalId?null:inspector&&sessionId?showRecords&&inspector.host&&createPortal(<ExecutionDetailsOpen.Provider value={true}><div className="inspector-turn-details">{records}</div></ExecutionDetailsOpen.Provider>,inspector.host)
  :details.length>0&&<div id={id} className={`turn-execution-details${open?' is-open':''}`} aria-hidden={!open} inert={!open} role="region" aria-label="执行详细过程"><div className="turn-execution-content"><div className="turn-execution-body"><ExecutionDetailsOpen.Provider value={open}>{records}</ExecutionDetailsOpen.Provider></div></div></div>;
 const footer=!hideStatus&&(!live||!hideLive)&&summary;
 return <RoutingRecoveryContext.Provider value={recoveredRouting}><ReplyProcessContext.Provider value={{pilot,footer:combinedReportId?{reportId:combinedReportId,status:footerStatus}:undefined}}>
  {children}{(!collaboration||live)&&footer}{specialistReplies}{collaboration?.(live?undefined:footer)}
 </ReplyProcessContext.Provider>{body}</RoutingRecoveryContext.Provider>;
}
