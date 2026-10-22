import type {AICard,AIView,ReplyTiming} from "../../shared/contracts";
import {compareTime} from "./timeline";
import {replyElapsed} from "./replyDurationState";

/** The metadata row owns the whole turn's state; operation rows only describe actions. */
export function turnStatus(timing:ReplyTiming|undefined,view:AIView|undefined,cards:AICard[],latestUserAt:string,now:number) {
 const live=timing ? timing.status==="running" : !!view && ["running","waiting_approval"].includes(view.status);
 const start=timing?.startedAt || latestUserAt;
 const currentCards=start ? cards.filter(card=>compareTime(card.at,start)>=0) : [];
 const compacting=!!start && view?.cards.some(card=>card.type==="compaction"&&card.status==="running"&&compareTime(card.at,start)>=0);
 const runs=(view?.agentRuns??[]).filter(run=>run.sessionId===view?.session && (view?.rootTurnId&&run.rootTurnId ? run.rootTurnId===view.rootTurnId : !!start&&compareTime(run.createdAt,start)>=0));
 const waiting=live && (view?.status==="waiting_approval" || !!view?.question || currentCards.some(card=>card.status==="pending") || runs.some(run=>run.status==="waiting_approval"||run.status==="waiting_input"||!!run.question));
 let state:string|undefined;
 if(live) {
  if(view?.question) state="等待你的选择";
  else if(waiting) state="等待确认";
  else if(compacting) state="正在压缩上下文…";
  else if(runs.some(run=>run.status==="running"||run.status==="queued")) state=`${runs.filter(run=>run.status==="running"||run.status==="queued").length} 个子任务执行中…`;
  else if(currentCards.some(card=>["operation","shell"].includes(card.type)&&card.status==="running")) state="正在执行工具…";
  else if(["message","text"].includes(currentCards.at(-1)?.type??"")&&currentCards.at(-1)?.status==="running") state="正在生成回复…";
  else state="正在思考…";
 } else {
  const last=currentCards.at(-1);
  const historical=!view && last && (["message","text"].includes(last.type)||last.type==="error") ? last.status : undefined;
  const status=timing?.status || view?.status || historical;
  state=status==="cancelled"?"已停止":status==="failed"?"未完成":status==="interrupted"?"记录已中断":status==="completed"?"回复结束":undefined;
  if(currentCards.some(card=>card.status==="unknown")) state="执行结果待核查";
  else if(currentCards.some(card=>card.status==="background_running")) state="后台命令仍在执行";
 }
 const duration=timing ? replyElapsed(timing,now) : undefined;
 const text=[duration,state].filter(Boolean).join(" · ") || undefined;
 return {text,duration,state,live,waiting};
}
