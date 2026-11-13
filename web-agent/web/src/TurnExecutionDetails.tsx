import {createPortal} from 'react-dom';
import {sessionInspectorId,useSessionInspector} from './SessionInspectorContext';
import {createContext,useId,useState,type ReactNode} from 'react';
import {ReplyDuration,type ReplyDurationProps} from './ReplyDuration';
import {turnStatus} from './turnStatus';
import {quietCoordination} from './coordinationActivity';
import {recoveredRouteFailures} from './routeDispatchPresentation';
export const ExecutionDetailsOpen=createContext(false);
export const RoutingRecoveryContext=createContext<ReadonlySet<string>>(new Set());
export function TurnExecutionDetails({details,onInspect,presentingReply=false,hideLive=false,hideStatus=false,hideIdentity:_hideIdentity=false,sessionId,latest=false,latestTaskId,canonicalGoalId,children,progress:_progress,...timing}:{hideStatus?:boolean;hideIdentity?:boolean;latest?:boolean;latestTaskId?:string;canonicalGoalId?:string;progress?:{text:string;active:boolean};hideLive?:boolean;sessionId?:string;children?:ReactNode;details:ReactNode[];onInspect?:()=>void;presentingReply?:boolean}&ReplyDurationProps){
 const id=useId();
 const inspector=useSessionInspector();
 const selection=inspector?.selection;
 const inspecting=!!selection&&selection.sessionId===sessionId&&(selection.followLatest?latest&&!latestTaskId:selection.tab==='execution'&&selection.turnId===id);
 const {live}=turnStatus(timing.timing,timing.view,timing.cards??[],timing.latestUserAt??'',Date.now());
 const [replyClock,setReplyClock]=useState({presenting:presentingReply,at:Date.now()});
 if(replyClock.presenting!==presentingReply)setReplyClock({presenting:presentingReply,at:Date.now()});
 const previewAt=live&&presentingReply&&!hideLive?replyClock.at:undefined;
 // Detail visibility belongs to the reader, never to a streaming/status update.
 const [open,setOpen]=useState(false);
 const recoveredRouting=recoveredRouteFailures(timing.cards??[]);
 const latestStep=timing.cards?.filter(card=>['operation','shell'].includes(card.type)&&!quietCoordination(card)&&!recoveredRouting.has(card.id)).at(-1);
 const summaryDisclosure=details.length||canonicalGoalId?{open:inspector&&sessionId?canonicalGoalId?selection?.canonicalGoalId===canonicalGoalId&&selection.tab==='execution':inspecting:open,controls:inspector&&sessionId?sessionInspectorId:id,side:!!(inspector&&sessionId),onToggle:()=>{
  if(inspector&&sessionId)inspector.open(canonicalGoalId?{sessionId,canonicalGoalId,tab:'execution'}:{sessionId,turnId:id,tab:'execution'});
  else {onInspect?.();setOpen(!open);}
 }}:undefined;
 // The status owns one fixed slot after prose in every lifecycle state.
 const summary=<ReplyDuration key="turn-duration" {...timing} previewAt={previewAt} latestStep={latestStep} disclosure={summaryDisclosure}/>;
 const body=canonicalGoalId?null:inspector&&sessionId?inspecting&&inspector.host&&createPortal(<ExecutionDetailsOpen.Provider value={true}><div className="inspector-turn-details">{details.length?details:<p className="inspector-empty">本轮尚无执行记录。</p>}</div></ExecutionDetailsOpen.Provider>,inspector.host)
  :details.length>0&&<div id={id} className={`turn-execution-details${open?' is-open':''}`} aria-hidden={!open} inert={!open} role="region" aria-label="执行详细过程"><div className="turn-execution-content"><div className="turn-execution-body"><ExecutionDetailsOpen.Provider value={open}>{details}</ExecutionDetailsOpen.Provider></div></div></div>;
 return <RoutingRecoveryContext.Provider value={recoveredRouting}>{children}{!hideStatus&&(!live||!hideLive)&&summary}{body}</RoutingRecoveryContext.Provider>;
}
