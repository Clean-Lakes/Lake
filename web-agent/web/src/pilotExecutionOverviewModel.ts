import type {Message,SuperWorker,SuperWorkspace,WorkSession} from '../../shared/contracts';
import {progressGlyph,toolDescription} from './activity';
import {quietCoordination} from './coordinationActivity';
import type {GlyphName} from './Icons';
import {confirmedRouteReceipt,matchesPilotForwarding,recoveredRouteFailures,type PilotSummarySlot} from './routeDispatchPresentation';
import {compareTime,type TranscriptEntry} from './timeline';

export function pilotTaskWorkers(workspace:SuperWorkspace|null|undefined,session:Pick<WorkSession,'id'|'projectId'>){
 if(!workspace?.active||workspace.project.projectId!==session.projectId||workspace.project.routerSessionId!==session.id)return [];
 return workspace.workers.filter(({parentWorkerId,sessionId,task})=>
  !parentWorkerId&&task.sessionId===sessionId&&(!task.projectId||task.projectId===session.projectId));
}

export type PilotExecutionAssignment={worker:SuperWorker;instruction?:string;report?:Message};

type PilotDispatch = Message & {dispatch:NonNullable<Message['dispatch']>};

function isPilotDispatch(message:Message,source:Message):message is PilotDispatch{
 return message.sessionId===source.sessionId&&message.role==='assistant'&&!message.author&&message.dispatch?.sourceMessageId===source.id;
}

function sameAssignment(worker:SuperWorker,record:Message['dispatch']|Message['author']){
 return record?.workerId===worker.id&&record.taskId===worker.task.taskId&&
  record.sessionId===worker.sessionId&&record.roleId===worker.roleId;
}

/** Use host links to this Pilot input. A recent update to another task never
 * makes its Worker or report part of this turn. */
export function latestPilotTaskAssignments(workspace:SuperWorkspace|null|undefined,session:Pick<WorkSession,'id'|'projectId'>,source:Message|undefined,messages:readonly Message[]):PilotExecutionAssignment[]{
 if(source?.role!=='user'||source.sessionId!==session.id)return [];
 const inSession=messages.filter(message=>message.sessionId===session.id).reverse();
 const assignments=pilotTaskWorkers(workspace,session).flatMap(worker=>{
  if(worker.assignmentState==='archived')return [];
  const dispatch=inSession.find((message):message is PilotDispatch=>isPilotDispatch(message,source)&&sameAssignment(worker,message.dispatch));
  const report=inSession.find(message=>message.role==='assistant'&&sameAssignment(worker,message.author)&&
   (message.replyToMessageId===source.id||!message.replyToMessageId&&worker.pilotSourceMessageId===source.id&&message.id===worker.pilotReport?.messageId));
  const activeSource=worker.activity?.sourceSessionId===session.id&&worker.activity.sourceMessageId===source.id;
  if(!dispatch&&!report&&!activeSource&&worker.pilotSourceMessageId!==source.id)return [];
  return [{worker,instruction:dispatch?.dispatch.instruction,report,at:dispatch?.createdAt??worker.createdAt??report?.createdAt??source.createdAt}];
 });
 const latest=assignments.reduce<typeof assignments[number]|undefined>((newest,assignment)=>
  !newest||compareTime(assignment.at,newest.at)>0?assignment:newest,undefined);
 return assignments.filter(assignment=>assignment.worker.task.taskId===latest?.worker.task.taskId);
}

export type PilotExecutionStep={id:string;at:string;label:string;icon:GlyphName;description?:string;running?:boolean;status?:string};

const statuses:Record<string,string>={
 pending:'待确认',failed:'失败',unknown:'结果待核查',not_executed:'未执行',
 cancelled:'已停止',interrupted:'已停止',
};

/** Project recorded dispatches, tool calls and summary events. The recorded
 * details stay available without guessing what Pilot did from its prose. */
export function pilotExecutionSteps(turn:readonly TranscriptEntry[],source:Message|undefined,summaries:readonly PilotSummarySlot[],messages:readonly Message[]):PilotExecutionStep[]{
 const dispatches=source?messages.filter((message):message is PilotDispatch=>isPilotDispatch(message,source)):[];
 const steps:PilotExecutionStep[]=dispatches.map(({id,createdAt,dispatch})=>({
  id,at:createdAt,label:dispatch.action==='followup'?`补充任务给${dispatch.roleName}`:`派单给${dispatch.roleName}`,
  description:dispatch.instruction,icon:'lakeWorkflow',
 }));
 const cards=turn.flatMap(({card})=>card&&(card.type==='operation'||card.type==='shell')?[card]:[]);
 const recoveredRoutes=recoveredRouteFailures(cards);
 for(const card of cards){
  const route=card.title==='route_work',read=card.title==='read_super_object';
  if(quietCoordination(card)&&!route&&!read)continue;
  const receipt=route&&confirmedRouteReceipt(card);
  if(receipt&&source&&dispatches.some(message=>matchesPilotForwarding(message,source,receipt)))continue;
  steps.push({id:card.id,at:card.at,label:route?'派发专员任务':read?'查阅任务记录':toolDescription(card),
   icon:route?'lakeWorkflow':progressGlyph(card),running:card.status==='running'||card.status==='background_running',
   status:recoveredRoutes.has(card.id)?'已恢复':statuses[card.status]});
 }
 for(const {id,round,final} of summaries){
  if(!final&&round?.state!=='summarizing')continue;
  steps.push({id:`summary:${id}`,at:final?.createdAt??round!.createdAt,icon:'lakeFile',
   label:final?'回传汇总结论':round?.kind==='task-summary'?'汇总专员报告':'汇总专员回应',running:!final});
 }
 return steps.sort((a,b)=>compareTime(a.at,b.at));
}
