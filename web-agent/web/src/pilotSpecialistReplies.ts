import type {Message,SessionSnapshot,SpecialistReplyAuthor,SuperWorker,SuperWorkspace} from '../../shared/contracts';
import {liveSpecialistReplies} from '../../shared/specialist-replies';

export type PilotSpecialistRow={projectId:string;worker:SuperWorker;activity:NonNullable<SuperWorker['activity']>;sourceMessageId:string;sourceCreatedAt:string;author:SpecialistReplyAuthor;reportedTurns:string[]};

/** Committed source bindings place each live specialist in its original user turn. */
export function pilotDispatchRows(workspace:SuperWorkspace|null|undefined,sessionId:string,messages:Message[]):PilotSpecialistRow[]{
 if(!workspace?.active||workspace.project.routerSessionId!==sessionId)return [];
 const newest=[...messages].reverse(),users=new Map(messages.filter(message=>message.role==='user').map(message=>[message.id,message]));
 return workspace.workers.flatMap(worker=>{
  if(worker.parentWorkerId||worker.task.sessionId!==worker.sessionId||worker.task.projectId&&worker.task.projectId!==workspace.project.projectId)return [];
  if(['archived','stopped'].includes(worker.assignmentState)||['completed','failed','cancelled'].includes(worker.task.state))return [];
  const activity=worker.activity;
  if(!activity||activity.sourceSessionId&&activity.sourceSessionId!==sessionId)return [];
  const dispatch=newest.find(message=>message.dispatch?.workerId===worker.id&&message.dispatch.taskId===worker.task.taskId&&message.dispatch.roleId===worker.roleId&&message.dispatch.sessionId===worker.sessionId)?.dispatch;
  const source=activity.sourceSessionId===sessionId?activity.sourceMessageId:undefined;
  if(!source&&!dispatch)return [];
  const sourceMessageId=source??dispatch!.sourceMessageId,user=users.get(sourceMessageId);
  if(!user)return [];
  const channel=workspace.channels?.find(item=>item.roleId===worker.roleId);
  const reports=messages.flatMap(message=>message.author?.workerId===worker.id&&message.author.sessionId===worker.sessionId&&message.author.taskId===worker.task.taskId&&message.author.roleId===worker.roleId&&message.author.rootTurnId?[message.author.rootTurnId]:[]);
  return [{projectId:workspace.project.projectId,worker,activity,sourceMessageId,sourceCreatedAt:user.createdAt,reportedTurns:reports,
   author:{kind:'specialist',name:worker.roleName,roleId:worker.roleId,workerId:worker.id,sessionId:worker.sessionId,taskId:worker.task.taskId,
    channelSessionId:channel?.sessionId??dispatch?.channelSessionId,execution:worker.execution?.backend}}];
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
 const started=Date.parse(view.turnStartedAt),source=Date.parse(row.sourceCreatedAt);
 if(!Number.isFinite(started)||!Number.isFinite(source)||started<source)return undefined;
 const backend=row.worker.execution?.backend,execution=snapshot.superagent?.execution;
 const runs=backend?.kind==='acp'&&execution?.backend.kind==='acp'&&execution.backend.agent===backend.agent?
  new Set(execution.runs.filter(run=>run.scope==='worker'&&run.agent===backend.agent).map(run=>run.id)):new Set<string>();
 const cards=view.cards.map(card=>{
  const data=card.data as Record<string,unknown>|undefined;
  const direct=card.type==='operation'&&runs.has(card.id)&&data?.source==='external_agent'&&data.external_run_id===card.id&&
   data.taskId===(row.worker.task.executionGoalId??row.worker.task.taskId)&&data.root_turn_id===view.rootTurnId&&!data.agentRunId&&!data.childSessionId;
  return direct?{...card,type:'message',at:card.at<view.turnStartedAt!?view.turnStartedAt!:card.at}:card;
 });
 const projectedSnapshot={...snapshot,ai:{...view,cards}};
 return liveSpecialistReplies([projectedSnapshot],[row.worker]).find(entry=>entry.reply?.turnId===view.rootTurnId);
}
