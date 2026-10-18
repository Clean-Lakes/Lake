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
 const visibleState=!live&&state==="回复结束"?undefined:state;
 useEffect(() => {
  setNow(Date.now());
  if (!live) return;
  const timer=window.setInterval(() => setNow(Date.now()),1000);
  return () => window.clearInterval(timer);
 },[timing?.messageId,timing?.startedAt,view?.turnStartedAt,live]);
 if (!text||!duration&&!visibleState) return null;
 return <div className={`reply-duration turn-status ${live ? "is-live" : "is-finished"} ${waiting ? "is-waiting" : ""}`} aria-label="回答耗时" title="本轮总耗时包含等待确认，不包含排队等待">{live&&!waiting&&<span className="turn-status-mark"><TurnActivityMark/></span>}<span className="turn-status-text">{duration&&<><span className="turn-status-elapsed">{!live&&"用时 "}{duration}</span>{visibleState&&<span aria-hidden="true"> · </span>}</>}{visibleState&&<span role={live?"status":undefined} aria-live={live?"polite":undefined} aria-atomic="true">{visibleState}</span>}</span></div>;
}
