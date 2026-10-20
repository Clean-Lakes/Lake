import {createContext,useId,useState,type ReactNode} from 'react';
import {ReplyDuration,type ReplyDurationProps} from './ReplyDuration';
export const ExecutionDetailsOpen=createContext(false);
export function TurnExecutionDetails({details,onInspect,...timing}:{details:ReactNode[];onInspect?:()=>void}&ReplyDurationProps){
 const id=useId(),[open,setOpen]=useState(false);
 // Cards are in this turn's original chronology; resource groups stay anchored
 // at first use and cannot identify the latest operation by display position.
 const latestStep=timing.cards?.filter(card=>['operation','shell'].includes(card.type)).at(-1);
 return <><ReplyDuration {...timing} latestStep={latestStep} disclosure={details.length?{open,controls:id,onToggle:()=>{onInspect?.();setOpen(value=>!value);}}:undefined}/>{details.length>0&&<div id={id} className="turn-execution-details" hidden={!open} role="region" aria-label="执行详细过程"><ExecutionDetailsOpen.Provider value={open}>{details}</ExecutionDetailsOpen.Provider></div>}</>;
}
