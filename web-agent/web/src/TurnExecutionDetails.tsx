import {createContext,useId,useState,type ReactNode} from 'react';
import {ReplyDuration,type ReplyDurationProps} from './ReplyDuration';
import {turnStatus} from './turnStatus';
export const ExecutionDetailsOpen=createContext(false);
export function TurnExecutionDetails({details,onInspect,...timing}:{details:ReactNode[];onInspect?:()=>void}&ReplyDurationProps){
 const id=useId();
 const {live}=turnStatus(timing.timing,timing.view,timing.cards??[],timing.latestUserAt??'',Date.now());
 const [disclosure,setDisclosure]=useState({live,open:live});
 // Follow lifecycle changes once; streaming snapshots must not override a user's
 // disclosure choice. Render-time adjustment also avoids a completion flash.
 if(disclosure.live!==live)setDisclosure({live,open:live});
 const open=disclosure.live===live?disclosure.open:live;
 const latestStep=timing.cards?.filter(card=>['operation','shell'].includes(card.type)).at(-1);
 return <><ReplyDuration {...timing} latestStep={latestStep} disclosure={details.length?{open,controls:id,onToggle:()=>{onInspect?.();setDisclosure({live,open:!open});}}:undefined}/>{details.length>0&&<div id={id} className={`turn-execution-details${open?' is-open':''}`} aria-hidden={!open} inert={!open} role="region" aria-label="执行详细过程"><div className="turn-execution-content"><div className="turn-execution-body"><ExecutionDetailsOpen.Provider value={open}>{details}</ExecutionDetailsOpen.Provider></div></div></div>}</>;
}
