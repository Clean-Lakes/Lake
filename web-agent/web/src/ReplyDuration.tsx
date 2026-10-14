import {useEffect,useState} from "react";
import type {AICard,AIView,ReplyTiming} from "../../shared/contracts";
import {turnStatus} from "./turnStatus";
const emptyCards:AICard[]=[];

function TurnActivityMark() {
 return <svg className="reply-duration-spinner turn-activity-mark" width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">{Array.from({length:8},(_,index)=><path key={index} d="M10 2v4" transform={`rotate(${index*45} 10 10)`}/>)}</svg>;
}
export function ReplyDuration({timing,view,cards=emptyCards,latestUserAt=""}: {timing?:ReplyTiming;view?:AIView;cards?:AICard[];latestUserAt?:string}) {
 const [now,setNow]=useState(Date.now);
 const {text,duration,state,live,waiting}=turnStatus(timing,view,cards,latestUserAt,now);
 useEffect(() => {
  setNow(Date.now());
  if (!live) return;
  const timer=window.setInterval(() => setNow(Date.now()),1000);
  return () => window.clearInterval(timer);
 },[timing?.messageId,timing?.startedAt,view?.turnStartedAt,live]);
 if (!text) return null;
 return <div className={`reply-duration turn-status ${live ? "is-live" : "is-finished"} ${waiting ? "is-waiting" : ""}`} aria-label="回答耗时" title="本轮总耗时包含等待确认，不包含排队等待"><span className="turn-status-mark">{live && !waiting ? <TurnActivityMark/> : <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><path d="M8 4.5V8l2.5 1.5"/></svg>}</span><span className="turn-status-text">{duration&&<><span className="turn-status-elapsed">{duration}</span>{state&&<span aria-hidden="true"> · </span>}</>}<span role={live?"status":undefined} aria-live={live?"polite":undefined} aria-atomic="true">{state}</span></span></div>;
}
