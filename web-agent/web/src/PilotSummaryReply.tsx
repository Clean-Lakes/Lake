import {useEffect,useRef,useState} from 'react';
import {AssistantMarkdown} from './AssistantMarkdown';
import type {SubscribePilotWorkerEvents} from './PilotWorkspace';
import type {PilotSummarySlot} from './routeDispatchPresentation';
import {usePilotSummaryHandoff} from './usePilotSummaryHandoff';
import {useSmoothText} from './useSmoothText';

function useSummaryPreview(slot:PilotSummarySlot,active:boolean,subscribe?:SubscribePilotWorkerEvents){
 const roundId=slot.round?.id,sessionId=slot.round?.sessionId;
 const snapshot=slot.round?.summary?.preview;
 const [latest,setLatest]=useState(snapshot);
 const preview=snapshot&&snapshot.seq>(latest?.seq??0)?snapshot:latest;
 if(preview!==latest)setLatest(preview);
 useEffect(()=>{
  if(!active||!roundId||!subscribe)return;
  let pending:typeof snapshot,frame:number|undefined;
  const unsubscribe=subscribe(roundId,{connection:()=>{},receive:event=>{
   const packet=event.pilotSummaryText;
   if(event.sessionId!==sessionId||packet?.roundId!==roundId||!Number.isSafeInteger(event.seq)||typeof packet.text!=='string')return;
   if(!pending||pending.seq<event.seq)pending={seq:event.seq,text:packet.text};
   frame??=requestAnimationFrame(()=>{
    frame=undefined;
    const next=pending;pending=undefined;
    if(next)setLatest(previous=>next.seq>(previous?.seq??0)?next:previous);
   });
  }});
  return()=>{unsubscribe();if(frame!==undefined)cancelAnimationFrame(frame);};
 },[active,roundId,sessionId,subscribe]);
 return preview?.text;
}

function SummaryProse({text,working,reveal,animateInitial,finishPending,arrive}:{
 text:string;working:boolean;reveal:boolean;animateInitial?:boolean;finishPending?:boolean;arrive:boolean;
}){
 const visible=useSmoothText(text,reveal,{animateInitial,finishPending});
 const moving=working||!!finishPending&&visible!==text;
 const observedMotion=useRef(moving);
 observedMotion.current ||= moving;
 return <AssistantMarkdown liveMotion={observedMotion.current?moving:undefined} pilotCursor={observedMotion.current} arrive={arrive}>{visible}</AssistantMarkdown>;
}

export function PilotSummaryReply({slot,connected,subscribe,arrive=false}:{slot:PilotSummarySlot;connected:boolean;subscribe?:SubscribePilotWorkerEvents;arrive?:boolean}){
 const summarizing=!slot.final&&slot.round?.state==='summarizing';
 const observedSummary=useRef(summarizing);
 observedSummary.current ||= summarizing;
 const active=summarizing||!slot.final&&slot.round?.state==='completed'&&observedSummary.current;
 const preview=useSummaryPreview(slot,summarizing&&connected,subscribe);
 const text=slot.final?.text??preview;
 const acknowledgement=slot.acknowledgement?.content??'正在汇总';
 const {body,visible,reveal}=usePilotSummaryHandoff({
  id:text?slot.id:undefined,
  roundId:slot.round?.id??slot.final?.conversation?.id,
  connected:connected&&!!slot.acknowledgement&&text!==acknowledgement,
 });
 const summary=visible&&!!text;
 return <div ref={body} className="ai-card ai-message" data-pilot-summary={slot.id}>
  <SummaryProse key={summary?slot.id:'acknowledgement'} text={summary?text:acknowledgement}
   working={connected&&active} reveal={connected&&summary&&active}
   animateInitial={summary&&reveal} finishPending={connected&&summary&&!active} arrive={connected&&arrive&&!reveal}/>
 </div>;
}
