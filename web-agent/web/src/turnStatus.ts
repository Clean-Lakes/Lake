import type {AICard,AIView,ReplyTiming} from "../../shared/contracts";
import {compareTime} from "./timeline";
import {replyElapsed} from "./replyDurationState";
import {quietCoordination} from './coordinationActivity';

export type TurnStatusPhase='thinking'|'compacting'|'delegating'|'tool'|'streaming'|'waiting'|'settled';
const terminalLabels:Record<string,string>={cancelled:'已停止',failed:'未完成',interrupted:'记录已中断',paused:'已暂停',blocked:'已暂停',completed:'回复结束'};
function replyActivityStatus(view?:AIView){
 const explicit=view?.status;
 // A new reply can run over an older blocked task; explicit interaction/stop states win.
 return explicit&&['queued','waiting_approval','waiting_input','waiting_external','paused','cancelled','failed','interrupted'].includes(explicit)?explicit:view?.replyStatus||explicit;
}

/** The metadata row owns the whole turn's state; operation rows only describe actions. */
export function turnStatus(timing:ReplyTiming|undefined,view:AIView|undefined,cards:AICard[],latestUserAt:string,now:number) {
 const activityStatus=replyActivityStatus(view);
 const live=timing ? timing.status==="running" : !!view && ["running","waiting_approval","waiting_input","waiting_external","queued"].includes(activityStatus??'');
 const start=timing?.startedAt || latestUserAt;
 const currentCards=start ? cards.filter(card=>compareTime(card.at,start)>=0) : [];
 // File changes and other passive attachments do not end a public reply stream.
 const lastActivity=currentCards.filter(card=>['thinking','message','text','operation','shell'].includes(card.type)).at(-1);
 const compacting=!!start && view?.cards.some(card=>card.type==="compaction"&&card.status==="running"&&compareTime(card.at,start)>=0);
 const runs=(view?.agentRuns??[]).filter(run=>run.sessionId===view?.session && (view?.rootTurnId&&run.rootTurnId ? run.rootTurnId===view.rootTurnId : !!start&&compareTime(run.createdAt,start)>=0));
 const terminalState=activityStatus?terminalLabels[activityStatus]:undefined;
 const waiting=live && !terminalState && (['waiting_approval','waiting_input','waiting_external','queued'].includes(activityStatus??'') || !!view?.question || !!view?.pending || !!view?.pendingApprovals?.length || currentCards.some(card=>card.status==="pending") || runs.some(run=>run.status==="waiting_approval"||run.status==="waiting_input"||!!run.question));
 let state:string|undefined;
 let phase:TurnStatusPhase='settled';
 if(live) {
  if(terminalState)state=terminalState;
  else if(waiting){
   phase='waiting';
   state=view?.question?"等待你的选择":view?.pending||view?.pendingApprovals?.length||activityStatus==='waiting_approval'?"等待确认":activityStatus==='waiting_input'?"等待你补充信息":activityStatus==='waiting_external'?"等待外部结果":activityStatus==='queued'?"排队等待":"等待确认";
  }
  else if(compacting){state="正在压缩上下文…";phase='compacting';}
  else if(runs.some(run=>run.status==="running"||run.status==="queued")){state=`${runs.filter(run=>run.status==="running"||run.status==="queued").length} 个子任务执行中…`;phase='delegating';}
  else if(currentCards.some(card=>["operation","shell"].includes(card.type)&&card.status==="running"&&!quietCoordination(card))){state="正在执行工具…";phase='tool';}
  else if(["message","text"].includes(lastActivity?.type??"")&&lastActivity?.status==="running"&&lastActivity?.content?.trim()){state="正在生成回复…";phase='streaming';}
  else {state="正在思考…";phase='thinking';}
 } else {
  const last=currentCards.at(-1);
  const historical=!view && last && (["message","text"].includes(last.type)||last.type==="error") ? last.status : undefined;
  const status=timing?.status || activityStatus || historical;
  state=status==="cancelled"?"已停止":status==="failed"?"未完成":status==="interrupted"?"记录已中断":status==="completed"?"回复结束":undefined;
  if(currentCards.some(card=>card.status==="unknown")) state="执行结果待核查";
  else if(currentCards.some(card=>card.status==="background_running")) state="后台命令仍在执行";
 }
 const duration=timing ? replyElapsed(timing,now) : undefined;
 const text=[duration,state].filter(Boolean).join(" · ") || undefined;
 return {text,duration,state,live,waiting,phase};
}

/** A delayed timing record cannot turn a wait, old view or terminal state into animal thinking. */
export function allowsAnimalThinking(view?:AIView){
 const status=replyActivityStatus(view);
 return !view?.question&&!view?.pending&&!view?.pendingApprovals?.length&&(!status||status==='idle'||status==='running');
}
