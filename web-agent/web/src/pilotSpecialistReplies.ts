import type {Message,SessionSnapshot,SpecialistReplyAuthor,SuperWorker,SuperWorkspace} from '../../shared/contracts';
import {liveSpecialistReplies} from '../../shared/specialist-replies';

type PilotSpecialistActivity=Omit<NonNullable<SuperWorker['activity']>,'phase'>&{phase:NonNullable<SuperWorker['activity']>['phase']|'updating'};
export type PilotSpecialistRow={projectId:string;routerSessionId?:string;worker:SuperWorker;activity:PilotSpecialistActivity;sourceMessageId:string;sourceCreatedAt:string;author:SpecialistReplyAuthor;reportedTurns:string[];continuity?:'updating'|'terminal';observedRootTurnId?:string;finalReport?:Message};

/** The UI may retain a dispatch slot, never transfer it to another owner. */
export function pilotSpecialistBinding(row:PilotSpecialistRow){
 const {worker}=row,backend=worker.execution?.backend;
 return JSON.stringify([row.projectId,row.routerSessionId??row.activity.sourceSessionId,worker.id,worker.roleId,worker.sessionId,worker.task.taskId,worker.task.executionGoalId,backend?.kind,backend?.kind==='acp'?backend.agent:undefined,row.sourceMessageId,row.sourceCreatedAt]);
}

function workerDispatch(worker:SuperWorker,sessionId:string,messages:Message[]){
 return [...messages].reverse().find(message=>message.sessionId===sessionId&&message.dispatch?.workerId===worker.id&&message.dispatch.taskId===worker.task.taskId&&message.dispatch.roleId===worker.roleId&&message.dispatch.sessionId===worker.sessionId)?.dispatch;
}

function workerReportedTurns(worker:SuperWorker,sessionId:string,messages:Message[]){
 return messages.flatMap(message=>message.sessionId===sessionId&&message.author?.workerId===worker.id&&message.author.sessionId===worker.sessionId&&message.author.taskId===worker.task.taskId&&message.author.roleId===worker.roleId&&message.author.rootTurnId?[message.author.rootTurnId]:[]);
}

/** A delivered report can replace only the invocation already seen in this slot. */
function workerFinalReport(worker:SuperWorker,sessionId:string,messages:Message[],observedRootTurnId?:string){
 if(!observedRootTurnId)return;
 return [...messages].reverse().find(message=>message.role==='assistant'&&message.sessionId===sessionId&&
  message.author?.kind==='specialist'&&message.author.workerId===worker.id&&message.author.roleId===worker.roleId&&
  message.author.sessionId===worker.sessionId&&message.author.taskId===worker.task.taskId&&message.author.rootTurnId===observedRootTurnId);
}

/** Committed source bindings place each live specialist in its original user turn. */
export function pilotDispatchRows(workspace:SuperWorkspace|null|undefined,sessionId:string,messages:Message[]):PilotSpecialistRow[]{
 if(!workspace?.active||workspace.project.routerSessionId!==sessionId)return [];
 const users=new Map(messages.filter(message=>message.role==='user'&&message.sessionId===sessionId).map(message=>[message.id,message]));
 return workspace.workers.flatMap(worker=>{
  if(worker.parentWorkerId||worker.task.sessionId!==worker.sessionId||worker.task.projectId&&worker.task.projectId!==workspace.project.projectId)return [];
  if(['archived','stopped'].includes(worker.assignmentState)||['completed','failed','cancelled'].includes(worker.task.state))return [];
  const activity=worker.activity;
  if(!activity||activity.sourceSessionId&&activity.sourceSessionId!==sessionId)return [];
  const dispatch=workerDispatch(worker,sessionId,messages);
  const source=activity.sourceSessionId===sessionId?activity.sourceMessageId:undefined;
  if(!source&&!dispatch)return [];
  const sourceMessageId=source??dispatch!.sourceMessageId,user=users.get(sourceMessageId);
  if(!user)return [];
  const channel=workspace.channels?.find(item=>item.roleId===worker.roleId);
  const reports=workerReportedTurns(worker,sessionId,messages);
  return [{projectId:workspace.project.projectId,routerSessionId:sessionId,worker,activity,sourceMessageId,sourceCreatedAt:user.createdAt,reportedTurns:reports,
   author:{kind:'specialist',name:worker.roleName,roleId:worker.roleId,workerId:worker.id,sessionId:worker.sessionId,taskId:worker.task.taskId,
    channelSessionId:channel?.sessionId??dispatch?.channelSessionId,execution:worker.execution?.backend}}];
 });
}

/** Keep an already observed dispatch in place across workspace/report refreshes.
 * Its exact delivered report takes over the same slot. Keep the observed root so
 * stale activity cannot flash it back; a fresh source binding admits the next root.
 */
export function continuousPilotDispatchRows(previous:PilotSpecialistRow[],workspace:SuperWorkspace|null|undefined,sessionId:string,messages:Message[],observedRoots:ReadonlyMap<string,string>=new Map()):PilotSpecialistRow[]{
 if(!workspace?.active||workspace.project.routerSessionId!==sessionId)return [];
 const fresh=new Map(pilotDispatchRows(workspace,sessionId,messages).map(row=>[row.worker.id,row]));
 const prior=new Map(previous.map(row=>[row.worker.id,row]));
 const users=new Map(messages.filter(message=>message.role==='user'&&message.sessionId===sessionId).map(message=>[message.id,message]));
 return workspace.workers.flatMap(worker=>{
  let row=fresh.get(worker.id);
  if(!row){
   const old=prior.get(worker.id);
   if(!old||worker.parentWorkerId||worker.assignmentState==='archived'||worker.task.sessionId!==worker.sessionId||worker.task.projectId&&worker.task.projectId!==workspace.project.projectId)return [];
   const user=users.get(old.sourceMessageId);
   if(!user||user.createdAt!==old.sourceCreatedAt||old.projectId!==workspace.project.projectId||old.routerSessionId!==sessionId||pilotSpecialistBinding(old)!==pilotSpecialistBinding({...old,worker}))return [];
   const activity=worker.activity,dispatch=workerDispatch(worker,sessionId,messages);
   if(activity?.sourceSessionId&&activity.sourceSessionId!==sessionId)return [];
   const source=activity?.sourceSessionId===sessionId?activity.sourceMessageId:undefined;
   if(source?source!==old.sourceMessageId:dispatch&&dispatch.sourceMessageId!==old.sourceMessageId)return [];
   const terminal=['completed','failed','cancelled'].includes(worker.task.state)||worker.assignmentState==='stopped';
   // A task may finish before its first SDK snapshot arrives. With no observed
   // root there is no safe report handoff to wait for; keep the original removal.
   if(terminal&&!observedRoots.get(pilotSpecialistBinding(old)))return [];
   const labels:Partial<Record<SuperWorker['task']['state'],string>>={completed:'执行结束',failed:'执行失败',cancelled:'已停止',waiting_user:'等待你补充信息',waiting_external:'等待外部结果',paused:'已暂停',blocked:'已暂停',queued:'等待开始'};
   const channel=workspace.channels?.find(item=>item.roleId===worker.roleId);
   row={...old,worker,continuity:terminal?'terminal':'updating',author:{...old.author,name:worker.roleName,channelSessionId:channel?.sessionId??dispatch?.channelSessionId??old.author.channelSessionId,execution:worker.execution?.backend},reportedTurns:workerReportedTurns(worker,sessionId,messages),
    activity:{phase:'updating',label:worker.assignmentState==='stopped'?'已停止':labels[worker.task.state]??'进度暂未更新',updatedAt:worker.task.updatedAt??old.activity.updatedAt,sourceSessionId:sessionId,sourceMessageId:old.sourceMessageId}};
  }
  const observedRootTurnId=observedRoots.get(pilotSpecialistBinding(row));
  return [{...row,observedRootTurnId,finalReport:workerFinalReport(worker,sessionId,messages,observedRootTurnId)}];
 });
}

export function specialistSnapshotMatches(row:PilotSpecialistRow,snapshot:SessionSnapshot){
 const {worker}=row,task=snapshot.superagent?.task;
 return snapshot.session.id===worker.sessionId&&snapshot.session.projectId===row.projectId&&
  snapshot.superagent?.roleId===worker.roleId&&task?.taskId===worker.task.taskId&&
  (!worker.task.executionGoalId||task.executionGoalId===worker.task.executionGoalId);
}

/** Public current-invocation prose only; thinking, tools and old replies stay private. */
export function pilotSpecialistReply(row:PilotSpecialistRow,snapshot?:SessionSnapshot){
 if(!snapshot||!specialistSnapshotMatches(row,snapshot)||row.activity.phase==='queued')return undefined;
 const view=snapshot.ai;
 if(!view?.turnStartedAt||!view.rootTurnId)return undefined;
 // A missing activity no longer proves where a new invocation came from: it
 // could be a direct specialist-channel request on the same worker/task.
 if(row.continuity&&view.rootTurnId!==row.observedRootTurnId)return undefined;
 const started=Date.parse(view.turnStartedAt),source=Date.parse(row.sourceCreatedAt);
 if(!Number.isFinite(started)||!Number.isFinite(source)||started<source)return undefined;
 const backend=row.worker.execution?.backend,execution=snapshot.superagent?.execution;
 const runs=backend?.kind==='acp'&&execution?.backend.kind==='acp'&&execution.backend.agent===backend.agent?
  new Set(execution.runs.filter(run=>run.scope==='worker'&&run.agent===backend.agent).map(run=>run.id)):new Set<string>();
 const cards=view.cards.map(card=>{
  const data=card.data as Record<string,unknown>|undefined;
  const direct=card.type==='operation'&&runs.has(card.id)&&data?.source==='external_agent'&&data.external_run_id===card.id&&
   data.taskId===(row.worker.task.executionGoalId??row.worker.task.taskId)&&data.root_turn_id===view.rootTurnId&&!data.agentRunId&&!data.childSessionId;
  const reply=direct?data?.external_reply as {id?:unknown;content?:unknown}|undefined:undefined;
  const publicSegment=reply&&typeof reply.id==='string'&&reply.id&&typeof reply.content==='string'?reply:undefined;
  return direct?{...card,type:'message',...(publicSegment?{id:publicSegment.id as string,content:publicSegment.content as string}:{}),at:card.at<view.turnStartedAt!?view.turnStartedAt!:card.at}:card;
 });
 const projectedSnapshot={...snapshot,ai:{...view,cards}};
 return liveSpecialistReplies([projectedSnapshot],[row.worker]).find(entry=>entry.reply?.turnId===view.rootTurnId);
}
