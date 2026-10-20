import {useEffect,useState} from "react";
import type {AICard,AIView,ReplyTiming} from "../../shared/contracts";
import {turnStatus} from "./turnStatus";
import {Glyph} from "./Icons";
const emptyCards:AICard[]=[];

function TurnActivityMark() {
 return <Glyph name="waves" size={18} className="reply-duration-spinner turn-activity-mark"/>;
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
 return <div className={`reply-duration turn-status ${live ? "is-live" : "is-finished"} ${waiting ? "is-waiting" : ""}`} aria-label="回答耗时" title="本轮总耗时包含等待确认，不包含排队等待">{live&&!waiting&&<span className="turn-status-mark"><TurnActivityMark/></span>}<span className="turn-status-text">{duration&&<><span className="turn-status-elapsed">{!live&&<Glyph name="clock" size={14} className="reply-duration-clock"/>}{duration}</span>{visibleState&&<span aria-hidden="true"> · </span>}</>}{visibleState&&<span role={live?"status":undefined} aria-live={live?"polite":undefined} aria-atomic="true">{visibleState}</span>}</span></div>;
}
