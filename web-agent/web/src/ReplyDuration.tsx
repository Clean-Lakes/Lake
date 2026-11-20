import {useEffect,useState} from "react";
import type {AICard,AIView,ReplyTiming} from "../../shared/contracts";
import {allowsAnimalThinking,turnStatus} from "./turnStatus";
import {Glyph} from "./Icons";
import {StatusText} from "./StatusText";
import {toolDescription} from "./activity";
import {ExecutionIcon} from './ExecutionIcon';
import {ReplyIdentity,showsReplyAvatar,type AssistantIdentity} from './ReplyIdentity';
import {conversationActivity,conversationAvatarMotion} from './superAgentPresentation';
import {AnimalThinkingBubble} from './AnimalThinkingBubble';
const emptyCards:AICard[]=[];

export type ReplyDurationProps={processLabel?:string;assistantIdentity?:AssistantIdentity;showThinkingAvatar?:boolean;connected?:boolean;current?:boolean;previewAt?:number;elapsedOnly?:boolean;processOnly?:boolean;timing?:ReplyTiming;view?:AIView;cards?:AICard[];latestUserAt?:string;detailNotice?:string;latestStep?:AICard;disclosure?:{open:boolean;controls:string;side?:boolean;onToggle:()=>void}};
export function ReplyDuration({assistantIdentity,showThinkingAvatar=true,connected=true,current=true,timing,view,cards=emptyCards,latestUserAt="",disclosure,detailNotice,latestStep,elapsedOnly=false,processOnly=false,processLabel='执行过程',previewAt}:ReplyDurationProps) {
 const [now,setNow]=useState(Date.now);
 const {text,duration,state,live,waiting,phase}=turnStatus(timing,view,cards,latestUserAt,previewAt??now);
 const preview=live&&previewAt!==undefined;
 const running=live&&!preview;
 const thinking=running&&!elapsedOnly&&!processOnly&&(state==='正在思考…'||state==='正在压缩上下文…');
 const animalThinking=thinking&&phase==='thinking'&&connected&&current&&!!assistantIdentity&&!assistantIdentity.pilot&&allowsAnimalThinking(view);
 const streamingReply=running&&!elapsedOnly&&state==='正在生成回复…';
 const avatar=showsReplyAvatar(assistantIdentity);
 const visibleState=processOnly||elapsedOnly||preview||streamingReply||!live&&state==="回复结束"?undefined:!connected&&running&&phase!=='settled'?'等待重新连接':state;
 const [presence,setPresence]=useState({running,reveal:false});
 if(presence.running!==running)setPresence({running,reveal:!running});

 useEffect(() => {
  setNow(Date.now());
  if (!running) return;
  const timer=window.setInterval(() => setNow(Date.now()),1000);
  return () => window.clearInterval(timer);
 },[timing?.messageId,timing?.startedAt,view?.turnStartedAt,running]);
 if((streamingReply||processOnly)&&!disclosure&&!detailNotice)return null;
 const startedAt=Date.parse(timing?.startedAt || view?.turnStartedAt || latestUserAt);
 if (live&&phase!=='settled'&&!waiting&&!thinking&&Number.isFinite(startedAt)&&now-startedAt<1000) return null;
 if ((!text||!duration&&!visibleState)&&!disclosure&&!detailNotice) return null;
 const stepDescription=latestStep?toolDescription(latestStep):'';
 const stepActive=running&&connected&&current&&phase!=='settled'&&!waiting&&!!latestStep&&['running','completed','succeeded','success'].includes(latestStep.status);
 const showDuration=!!duration&&!streamingReply&&!processOnly;
 if(elapsedOnly&&!showDuration)return null;
 if(animalThinking){
  const meta=<>{showDuration&&<span className="turn-status-elapsed">已处理 {duration}</span>}{!showDuration&&disclosure&&<span>{processLabel}</span>}{detailNotice&&<span className="turn-execution-notice">{showDuration||disclosure?' · ':''}{detailNotice}</span>}{disclosure&&<Glyph name="next" size={11} className="turn-duration-chevron"/>}</>;
  return <div className="reply-duration reply-process-text turn-status is-live is-thinking without-avatar is-animal-thinking" aria-label="执行状态">
   <AnimalThinkingBubble name={assistantIdentity.name} roleId={assistantIdentity.roleId} avatarId={assistantIdentity.avatarId}/>
   {(showDuration||disclosure||detailNotice)&&<div className="animal-thinking-meta">{disclosure?<button type="button" className="turn-duration-disclosure" data-placement={disclosure.side?'side':'inline'} aria-label="查看执行详细过程" aria-expanded={disclosure.open} aria-controls={disclosure.controls} title={disclosure.side?'在右侧查看执行详细过程':disclosure.open?'收起执行详细过程':'展开执行详细过程'} onClick={disclosure.onToggle}>{meta}</button>:meta}</div>}
  </div>;
 }
 const active=running&&connected&&current&&phase!=='settled';
 const label=<><span className="turn-status-text"><StatusText active={active&&!waiting&&!streamingReply}>{showDuration&&<><span className="turn-status-elapsed">{running?'已处理':'用时'} {duration}</span>{visibleState&&<span aria-hidden="true"> · </span>}</>}{!showDuration&&!visibleState&&disclosure&&<span>{processLabel}</span>}{visibleState&&<span role={running?"status":undefined} aria-live={running?"polite":undefined} aria-atomic="true">{visibleState}</span>}</StatusText>{detailNotice&&<span className="turn-execution-notice"> · {detailNotice}</span>}</span>{disclosure&&<Glyph name="next" size={11} className="turn-duration-chevron"/>}</>;
 return <div className={`reply-duration reply-process-text turn-status ${preview ? "is-preview" : live ? "is-live" : "is-finished"} ${waiting ? "is-waiting" : ""}${thinking?` is-thinking${avatar?'':' without-avatar'}`:''}${presence.reveal&&!running?" is-revealed":""}`} aria-label={processOnly?"执行过程":running?"执行状态":"回答耗时"} title={thinking?`${state?.replace(/…$/,'')}${duration?` · 已处理 ${duration}`:''}`:preview?"截至结论开始输出时的处理用时":live?undefined:"本轮总耗时包含等待确认，不包含排队等待"}>{thinking&&avatar&&showThinkingAvatar&&<span className="turn-thinking-avatar" aria-hidden="true"><ReplyIdentity identity={assistantIdentity} motion={active?conversationAvatarMotion(waiting?'waiting':conversationActivity(view)):'still'}/></span>}{disclosure?<button type="button" className="turn-duration-disclosure" data-placement={disclosure.side?"side":"inline"} aria-label={thinking?'查看执行详细过程':undefined} aria-expanded={disclosure.open} aria-controls={disclosure.controls} title={disclosure.side?'在右侧查看执行详细过程':disclosure.open?'收起执行详细过程':'展开执行详细过程'} onClick={disclosure.onToggle}>{label}{running&&!processOnly&&!streamingReply&&!disclosure.open&&latestStep&&!(thinking&&["completed","succeeded","success"].includes(latestStep.status))&&<span className="turn-current-step" aria-label={`最新步骤：${stepDescription}`} title={stepDescription}><ExecutionIcon card={latestStep} active={stepActive}/><StatusText active={stepActive} className="turn-current-step-label">{stepDescription}</StatusText></span>}</button>:label}</div>;
}
