import {createContext,useEffect,useId,useRef,useState,type ReactNode} from 'react';
import {ReplyDuration,type ReplyDurationProps} from './ReplyDuration';
import {turnStatus} from './turnStatus';
export const ExecutionDetailsOpen=createContext(false);
export function TurnExecutionDetails({details,onInspect,presentingReply=false,...timing}:{details:ReactNode[];onInspect?:()=>void;presentingReply?:boolean}&ReplyDurationProps){
 const id=useId();
 const {live}=turnStatus(timing.timing,timing.view,timing.cards??[],timing.latestUserAt??'',Date.now());
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
 return <><ReplyDuration {...timing} latestStep={latestStep} disclosure={details.length?{open,controls:id,onToggle:()=>{onInspect?.();setDisclosure({active,open:!open});}}:undefined}/>{details.length>0&&<div id={id} className={`turn-execution-details${open?' is-open':''}`} aria-hidden={!open} inert={!open} role="region" aria-label="执行详细过程"><div className="turn-execution-content"><div className="turn-execution-body"><ExecutionDetailsOpen.Provider value={open}>{shownDetails}</ExecutionDetailsOpen.Provider></div></div></div>}</>;
}
