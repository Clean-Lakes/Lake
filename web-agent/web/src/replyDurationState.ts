import type {ReplyTiming,SessionSnapshot} from "../../shared/contracts";
import {formatElapsed} from "./activity";
import {compareTime,type TranscriptEntry} from "./timeline";

export function timingForTurn(turn:TranscriptEntry[],snapshot:SessionSnapshot):ReplyTiming|undefined {
 const user=turn.find(entry => entry.message?.role==="user")?.message;
 if (!user) return;
 const saved=snapshot.replyTimings?.find(timing => timing.messageId===user.id);
 if (saved) return saved;
 // Older builds retained exact times for the latest engine turn only.
 const latest=snapshot.messages.filter(message => message.role==="user").at(-1);
 const view=snapshot.ai;
 if (user.id!==latest?.id || !view?.turnStartedAt || compareTime(view.turnStartedAt,user.createdAt)<0) return;
 if (["running","waiting_approval"].includes(view.status)) return {messageId:user.id,startedAt:user.createdAt,finishedAt:"",status:"running"};
 if (!view.turnFinishedAt || !["completed","cancelled","failed"].includes(view.status)) return;
 return {messageId:user.id,startedAt:view.turnStartedAt,finishedAt:view.turnFinishedAt,status:view.status as ReplyTiming["status"]};
}
export function replyDurationText(timing:ReplyTiming,now:number,waiting=false):string|undefined {
 if (timing.status==="interrupted") return;
 const start=Date.parse(timing.startedAt),end=timing.status==="running" ? now : Date.parse(timing.finishedAt);
 const milliseconds=end-start;
 if (!Number.isFinite(milliseconds) || milliseconds<0) return;
 const duration=milliseconds<1000 ? "不到1秒" : formatElapsed(Math.floor(milliseconds/1000));
 if (timing.status==="running") return `${waiting ? "等待确认" : "正在回答"} · 已用时 ${duration}`;
 if (timing.status==="cancelled") return `本轮耗时 ${duration} · 已停止`;
 if (timing.status==="failed") return `本轮耗时 ${duration} · 未完成`;
 return `回答耗时 ${duration}`;
}
