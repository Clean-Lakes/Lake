import {createPortal} from 'react-dom';
import {sessionInspectorId,useSessionInspector} from './SessionInspectorContext';
import {createContext,useEffect,useId,useRef,useState,type ReactNode} from 'react';
import {ReplyDuration,type ReplyDurationProps} from './ReplyDuration';
import {turnStatus} from './turnStatus';
import {StatusText} from './StatusText';
export const ExecutionDetailsOpen=createContext(false);
export function TurnExecutionDetails({details,onInspect,presentingReply=false,hideLive=false,sessionId,children,progress,...timing}:{progress?:{text:string;active:boolean};hideLive?:boolean;sessionId?:string;children?:ReactNode;details:ReactNode[];onInspect?:()=>void;presentingReply?:boolean}&ReplyDurationProps){
 const id=useId();
 const inspector=useSessionInspector();
 const selection=inspector?.selection;
 const inspecting=selection?.sessionId===sessionId&&selection?.turnId===id&&selection.tab==='execution';
 const {live,waiting}=turnStatus(timing.timing,timing.view,timing.cards??[],timing.latestUserAt??'',Date.now());
 const active=live&&!presentingReply;
 const [disclosure,setDisclosure]=useState({active,open:active});
 const previousDetails=useRef(details);
 const [retiringDetails,setRetiringDetails]=useState<ReactNode[]|null>(null);
 // Follow lifecycle changes once; streaming snapshots must not override a user's
 // disclosure choice. Render-time adjustment also avoids a completion flash.
 if(disclosure.active!==active){
  setRetiringDetails(presentingReply?previousDetails.current:null);
  setDisclosure({active,open:active});
 }
 previousDetails.current=details;
 const open=disclosure.active===active?disclosure.open:active;
 const shownDetails=!open&&retiringDetails?retiringDetails:details;
 useEffect(()=>{
  if(!retiringDetails)return;
  const timer=setTimeout(()=>setRetiringDetails(null),400);
  return()=>clearTimeout(timer);
 },[retiringDetails]);
 const latestStep=timing.cards?.filter(card=>['operation','shell'].includes(card.type)).at(-1);
 const summaryDisclosure=details.length?{open:inspector&&sessionId?inspecting:open,controls:inspector&&sessionId?sessionInspectorId:id,side:!!(inspector&&sessionId),onToggle:()=>{
  if(inspector&&sessionId)inspector.open({sessionId,turnId:id,tab:'execution'});
  else {onInspect?.();setDisclosure({active,open:!open});}
 }}:undefined;
 // Keep a keyed status node as new prose arrives. It follows live content,
 // then moves above the reply once the saved turn timing is final.
 const summary=<ReplyDuration key="turn-duration" {...timing} latestStep={progress?undefined:latestStep} disclosure={summaryDisclosure}/>;
 const body=inspector&&sessionId?inspecting&&inspector.host&&createPortal(<ExecutionDetailsOpen.Provider value={true}><div className="inspector-turn-details">{details}</div></ExecutionDetailsOpen.Provider>,inspector.host)
  :details.length>0&&<div id={id} className={`turn-execution-details${open?' is-open':''}`} aria-hidden={!open} inert={!open} role="region" aria-label="执行详细过程"><div className="turn-execution-content"><div className="turn-execution-body"><ExecutionDetailsOpen.Provider value={open}>{shownDetails}</ExecutionDetailsOpen.Provider></div></div></div>;
 return <>{!live&&summary}{children}{live&&!hideLive&&progress?.text&&<div className="turn-latest-progress" role="note" aria-label="最新进度" title={progress.text}><StatusText active={!waiting&&progress.active}>{progress.text}</StatusText></div>}{body}{live&&!hideLive&&summary}</>;
}
