import type {AICard,ExternalReplyStage,SessionEvent} from '../../web-agent/shared/contracts';
import {directExternalOperationData,externalReplyStages,updateExternalReplyStages} from '../../web-agent/shared/external-agents';
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

/** Keep one redacted prefix per public message and counts per consecutive tool group. */
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
  if(event.kind==='tool'&&event.status==='running'&&!call){
   const tail=stages.at(-1);
   const group=tail?.kind==='tools'?tail:{kind:'tools' as const,id:`tools:${stages.length}`,progress:{total:0,running:0,failed:0}};
   stage={...group,progress:{...group.progress,total:group.progress.total+1,running:group.progress.running+1}};
   calls.set(event.callId,{stageId:group.id,running:true});
  }else if(call?.running&&event.kind==='tool_update'&&(event.status==='completed'||event.status==='failed')){
   const group=stages.find(item=>item.kind==='tools'&&item.id===call.stageId);
   if(group?.kind!=='tools')return;
   call.running=false;
   stage={...group,progress:{...group.progress,running:group.progress.running-1,failed:group.progress.failed+(event.status==='failed'?1:0)}};
  }
 }
 if(!stage)return;
 card.data={...data,external_reply_stages:updateExternalReplyStages(stages,stage)};
 // A text event already carries its redacted prefix in textUpdate.
 return {id:run.id,taskId:run.taskId,rootTurnId:run.rootTurnId,stage:stage.kind==='prose'?{kind:stage.kind,id:stage.id}:stage};
}
