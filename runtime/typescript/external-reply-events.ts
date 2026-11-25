import type {AICard,ExternalReplyStage,SessionEvent} from '../../web-agent/shared/contracts';
import {directExternalOperationData,externalReplyStages,isExternalToolAction,updateExternalReplyStages} from '../../web-agent/shared/external-agents';
import type {ExternalEvent,ExternalRun} from './acp/types';

type WorkerRun=Pick<ExternalRun,'purpose'|'childSessionId'|'agentRunId'>;
function rootWorker(run:WorkerRun){
 return run.purpose==='worker'&&!run.childSessionId&&!run.agentRunId;
}

/** Only a root Worker's public ACP text gets a prefix event; the audit card stays an operation. */
export function externalReplyTextUpdate(run:WorkerRun,event:Pick<ExternalEvent,'kind'>,card:AICard,rootTurnId?:string):Partial<SessionEvent>{
 if(event.kind!=='text'||!rootWorker(run)||!rootTurnId)return {};
 const reply=(card.data as {external_reply?:{id?:unknown;content?:unknown}}|undefined)?.external_reply;
 const externalReply=typeof reply?.id==='string'&&reply.id&&typeof reply.content==='string'?{id:reply.id,content:reply.content}:undefined;
 return {textUpdate:{target:'card',id:card.id,content:card.content??'',cardType:'operation',at:card.at,rootTurnId,...(externalReply&&{externalReply})}};
}

const toolCalls=new WeakMap<ExternalRun,Map<string,{stageId:string;running:boolean}>>();

/** Keep each public message and each distinct tool action in execution order. */
export function recordExternalReplyStage(run:ExternalRun,event:ExternalEvent,card:AICard):SessionEvent['externalReplyStageUpdate']{
 if(!rootWorker(run)||!run.taskId||!run.rootTurnId)return;
 const data=directExternalOperationData(card,run.rootTurnId);
 if(!data||data.taskId!==run.taskId||card.id!==run.id)return;
 const stages=externalReplyStages(data.external_reply_stages);
 let stage:ExternalReplyStage|undefined;
 if(event.kind==='text'&&event.publicTextId){
  // Use the same host-redacted prefix already projected on the operation card.
  const reply=data.external_reply as {id?:string;content?:string}|undefined;
  if(reply?.id===event.publicTextId&&reply.content?.trim())stage={kind:'prose',id:reply.id,content:reply.content};
 }else if(event.callId&&(event.kind==='tool'||event.kind==='tool_update')){
  let calls=toolCalls.get(run);
  if(!calls)toolCalls.set(run,calls=new Map());
  const call=calls.get(event.callId);
  const starting=event.kind==='tool'&&event.status==='running';
  const ending=event.kind==='tool_update'&&(event.status==='completed'||event.status==='failed');
  const failed=event.status==='failed'?1:0;
  const action=isExternalToolAction(event.action)?event.action:undefined;
  if(!call&&(starting||ending)){
   const tail=stages.at(-1);
   const sameAction=tail?.kind==='tools'&&tail.action?.tool===action?.tool&&tail.action?.integration===action?.integration&&
    !(action?.tool==='call_mcp_tool'&&!action.integration);
   const group=sameAction?tail:{kind:'tools' as const,id:`tools:${stages.length}`,progress:{total:0,running:0,failed:0},...(action&&{action})};
   stage={...group,progress:{total:group.progress.total+1,running:group.progress.running+Number(starting),failed:group.progress.failed+failed}};
   calls.set(event.callId,{stageId:group.id,running:starting});
  }else if(call?.running&&ending){
   const group=stages.find(item=>item.kind==='tools'&&item.id===call.stageId);
   if(group?.kind!=='tools')return;
   call.running=false;
   const named=group.progress.total===1&&!group.action?.integration&&action?.integration?{action}:{};
   stage={...group,...named,progress:{...group.progress,running:group.progress.running-1,failed:group.progress.failed+failed}};
  }
 }
 if(!stage)return;
 card.data={...data,external_reply_stages:updateExternalReplyStages(stages,stage)};
 // A text event already carries its redacted prefix in textUpdate.
 return {id:run.id,taskId:run.taskId,rootTurnId:run.rootTurnId,stage:stage.kind==='prose'?{kind:stage.kind,id:stage.id}:stage};
}
