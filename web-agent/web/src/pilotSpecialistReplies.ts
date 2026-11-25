import type {AICard,ExternalToolProgress,Message,SessionSnapshot,SpecialistChannelEntry,SpecialistReplyAuthor,SuperWorker,SuperWorkspace} from '../../shared/contracts';
import {directExternalOperationData,externalReplyStages} from '../../shared/external-agents';
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

/** A host report may be written by a different SDK invocation of the same task. */
function workerFinalReport(row:PilotSpecialistRow,sessionId:string,messages:Message[],observedRootTurnId?:string){
 const {worker,sourceMessageId}=row;
 return [...messages].reverse().find(message=>{
  const author=message.author;
  if(message.role!=='assistant'||message.sessionId!==sessionId||(message.replyToMessageId&&message.replyToMessageId!==sourceMessageId)||
     author?.kind!=='specialist'||author.workerId!==worker.id||author.roleId!==worker.roleId||
     author.sessionId!==worker.sessionId||author.taskId!==worker.task.taskId)return false;
  if(observedRootTurnId&&author.rootTurnId===observedRootTurnId)return true;
  // Match the host's report ID, or its explicit source when the message update
  // arrives before the workspace update carrying that ID.
  return message.replyToMessageId===sourceMessageId&&(
   message.id===worker.pilotReport?.messageId||!!observedRootTurnId&&!!author.rootTurnId&&Date.parse(message.createdAt)>=Date.parse(row.activity.updatedAt)
  );
 });
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
   // A queued/fast reply can settle before its first visible SDK packet. A
   // host report ID still proves the same display slot and its conclusion.
   if(terminal&&!worker.pilotReport&&!observedRoots.get(pilotSpecialistBinding(old)))return [];
   const labels:Partial<Record<SuperWorker['task']['state'],string>>={completed:'执行结束',failed:'执行失败',cancelled:'已停止',waiting_user:'等待你补充信息',waiting_external:'等待外部结果',paused:'已暂停',blocked:'已暂停',queued:'等待开始'};
   const channel=workspace.channels?.find(item=>item.roleId===worker.roleId);
   row={...old,worker,continuity:terminal?'terminal':'updating',author:{...old.author,name:worker.roleName,channelSessionId:channel?.sessionId??dispatch?.channelSessionId??old.author.channelSessionId,execution:worker.execution?.backend},reportedTurns:workerReportedTurns(worker,sessionId,messages),
    activity:{phase:'updating',label:worker.assignmentState==='stopped'?'已停止':labels[worker.task.state]??'进度暂未更新',updatedAt:worker.task.updatedAt??old.activity.updatedAt,sourceSessionId:sessionId,sourceMessageId:old.sourceMessageId}};
  }
  const observedRootTurnId=observedRoots.get(pilotSpecialistBinding(row));
  return [{...row,observedRootTurnId,finalReport:workerFinalReport(row,sessionId,messages,observedRootTurnId)}];
 });
}

export function specialistSnapshotMatches(row:PilotSpecialistRow,snapshot:SessionSnapshot){
 const {worker}=row,task=snapshot.superagent?.task;
 return snapshot.session.id===worker.sessionId&&snapshot.session.projectId===row.projectId&&
  snapshot.superagent?.roleId===worker.roleId&&task?.taskId===worker.task.taskId&&
  (!worker.task.executionGoalId||task.executionGoalId===worker.task.executionGoalId);
}

/** Execution ending and its formal report can arrive on separate streams. */
export function awaitingPilotReport(row:PilotSpecialistRow,snapshot?:SessionSnapshot){
 if(row.worker.assignmentState==='stopped'||['failed','cancelled'].includes(row.worker.task.state))return false;
 if(row.continuity==='terminal')return row.worker.task.state==='completed';
 // The worker snapshot can report completion before the workspace does.
 return !!row.observedRootTurnId&&!!snapshot&&specialistSnapshotMatches(row,snapshot)&&snapshot.superagent?.task.state==='completed'&&
  (!snapshot.ai?.rootTurnId||snapshot.ai.rootTurnId===row.observedRootTurnId);
}

export type PilotReplyStage={kind:'prose';id:string;card:AICard}|{kind:'tools';id:string;progress:ExternalToolProgress};
type PilotReplyEntry=SpecialistChannelEntry&{stages:PilotReplyStage[]};
export type PilotReplyPresentation={binding:string;entry?:PilotReplyEntry};

export function pilotToolStageLabel({total,running,failed}:ExternalToolProgress,active:boolean){
 const ended=total-running;
 return ['工具调用',running>0&&`${running} 项${active?'执行中':'未结束'}`,ended>0&&`${ended} 项已结束`,failed>0&&`${failed} 项失败`].filter(Boolean).join(' · ');
}

/** Keep the last committed public segment until the host's exact report takes
 * over. A late completion snapshot is audit data, not another public update. */
export function pilotSpecialistPresentation(row:PilotSpecialistRow,snapshot:SessionSnapshot|undefined,previous?:PilotReplyPresentation){
 if(awaitingPilotReport(row,snapshot)&&previous?.binding===pilotSpecialistBinding(row)&&
  previous.entry?.reply?.turnId===row.observedRootTurnId)return previous.entry;
 return pilotSpecialistReply(row,snapshot);
}

/** Project the current invocation's public stages, with count-only tool groups. */
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
 const stages:PilotReplyStage[]=[];
 const cards=view.cards.flatMap(card=>{
  const data=card.data as Record<string,unknown>|undefined;
  const operation=runs.has(card.id)&&directExternalOperationData(card,view.rootTurnId!);
  if(!operation||operation.taskId!==(row.worker.task.executionGoalId??row.worker.task.taskId)){
   if((card.type==='message'||card.type==='text')&&data?.root_turn_id===view.rootTurnId&&card.at>=view.turnStartedAt!&&card.content?.trim()){
    stages.push({kind:'prose',id:card.id,card});
   }
   return [card];
  }
  const at=card.at<view.turnStartedAt!?view.turnStartedAt!:card.at;
  const timeline=externalReplyStages(operation.external_reply_stages);
  if(timeline.length)return timeline.flatMap(stage=>{
   const id=JSON.stringify([card.id,stage.kind,stage.id]);
   if(stage.kind==='tools'){
    stages.push({...stage,id});
    return [];
   }
   if(!stage.content.trim())return [];
   const message={...card,id:stage.id,type:'message',at,content:stage.content};
   stages.push({kind:'prose',id,card:message});
   return [message];
  });
  const reply=operation.external_reply as {id?:unknown;content?:unknown}|undefined;
  const publicSegment=reply&&typeof reply.id==='string'&&reply.id&&typeof reply.content==='string'?reply:undefined;
  return [{...card,type:'message',...(publicSegment?{id:publicSegment.id as string,content:publicSegment.content as string}:{}),at}];
 });
 const projectedSnapshot={...snapshot,ai:{...view,cards}};
 const entry=liveSpecialistReplies([projectedSnapshot],[row.worker]).find(entry=>entry.reply?.turnId===view.rootTurnId);
 const latestProse=stages.filter(stage=>stage.kind==='prose').at(-1);
 return entry?{...entry,stages:latestProse?.card.id===entry.card?.id?stages:[]}:undefined;
}
