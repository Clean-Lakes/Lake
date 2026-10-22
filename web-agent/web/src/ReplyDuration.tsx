import {useEffect,useState} from "react";
import type {AICard,AIView,ReplyTiming} from "../../shared/contracts";
import {turnStatus} from "./turnStatus";
import {Glyph} from "./Icons";
import {StatusText} from "./StatusText";
import {toolDescription} from "./activity";
import {ExecutionIcon} from './ExecutionIcon';
const emptyCards:AICard[]=[];

function TurnActivityMark() {
 return <Glyph name="waves" size={18} className="reply-duration-spinner turn-activity-mark"/>;
}
export type ReplyDurationProps={timing?:ReplyTiming;view?:AIView;cards?:AICard[];latestUserAt?:string;detailNotice?:string;latestStep?:AICard;disclosure?:{open:boolean;controls:string;onToggle:()=>void}};
export function ReplyDuration({timing,view,cards=emptyCards,latestUserAt="",disclosure,detailNotice,latestStep}:ReplyDurationProps) {
 const [now,setNow]=useState(Date.now);
 const {text,duration,state,live,waiting}=turnStatus(timing,view,cards,latestUserAt,now);
 const visibleState=!live&&state==="回复结束"?undefined:state;

 useEffect(() => {
  setNow(Date.now());
  if (!live) return;
  const timer=window.setInterval(() => setNow(Date.now()),1000);
  return () => window.clearInterval(timer);
 },[timing?.messageId,timing?.startedAt,view?.turnStartedAt,live]);
 const startedAt=Date.parse(timing?.startedAt || view?.turnStartedAt || latestUserAt);
 if (live&&!waiting&&Number.isFinite(startedAt)&&now-startedAt<1000) return null;
 if ((!text||!duration&&!visibleState)&&!disclosure) return null;
 const stepDescription=latestStep?toolDescription(latestStep):'';
 const stepActive=live&&!waiting&&!!latestStep&&['running','completed','succeeded','success'].includes(latestStep.status);
 const label=<>{live&&!waiting&&<span className="turn-status-mark"><TurnActivityMark/></span>}<span className="turn-status-text"><StatusText active={live&&!waiting}>{duration&&<><span className="turn-status-elapsed">用时 {duration}</span>{visibleState&&<span aria-hidden="true"> · </span>}</>}{!duration&&!visibleState&&disclosure&&<span>执行过程</span>}{visibleState&&<span role={live?"status":undefined} aria-live={live?"polite":undefined} aria-atomic="true">{visibleState}</span>}</StatusText>{detailNotice&&<span className="turn-execution-notice"> · {detailNotice}</span>}</span>{disclosure&&<Glyph name="next" size={11} className="turn-duration-chevron"/>}</>;
 return <div className={`reply-duration turn-status ${live ? "is-live" : "is-finished"} ${waiting ? "is-waiting" : ""}`} aria-label="回答耗时" title="本轮总耗时包含等待确认，不包含排队等待">{disclosure?<button type="button" className="turn-duration-disclosure" aria-expanded={disclosure.open} aria-controls={disclosure.controls} title={disclosure.open?'收起执行详细过程':'展开执行详细过程'} onClick={disclosure.onToggle}>{label}{live&&!disclosure.open&&latestStep&&<span className="turn-current-step" aria-label={`最新步骤：${stepDescription}`} title={stepDescription}><ExecutionIcon card={latestStep} active={stepActive}/><StatusText active={stepActive} className="turn-current-step-label">{stepDescription}</StatusText></span>}</button>:label}</div>;
}
