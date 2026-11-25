import type {SessionEvent,SessionSnapshot} from '../../shared/contracts';
import {directExternalOperationData,externalReplyStages,isExternalReplyStage,updateExternalReplyStages} from '../../shared/external-agents';

// Live events address one item. They carry its received prefix, making replay,
// dropped packets and Unicode boundaries independent of network chunking.
// Snapshots remain authoritative for completion, approvals and reconnection.
export function applyLiveText(previous:SessionSnapshot|null,event:SessionEvent):SessionSnapshot|null {
 const update=event.textUpdate,ai=previous?.ai;
 if(!previous||previous.session.id!==event.sessionId||!ai||!update||typeof update.content!=='string'||!update.id)return null;
 if(event.seq<=previous.cursor)return previous;
 if(update.target==='agent'){
  const index=ai.agentRuns?.findIndex(run=>run.id===update.id)??-1;
  if(index<0||!update.textId)return null;
  const run=ai.agentRuns![index]!;
  if(run.status!=='running')return null;
  const agentRuns=ai.agentRuns!.map((item,i)=>i===index?{...item,liveText:update.content,liveTextId:update.textId}:item);
  return {...previous,cursor:event.seq,ai:{...ai,agentRuns}};
 }
 if(update.target!=='card'||!['message','thinking','operation'].includes(update.cardType??'')||ai.status!=='running'||!update.rootTurnId||update.rootTurnId!==ai.rootTurnId)return null;
 const index=ai.cards.findIndex(card=>card.id===update.id);
 if(update.cardType==='operation'&&!directExternalOperationData(ai.cards[index],update.rootTurnId))return null;
 if(update.externalReply&&(update.cardType!=='operation'||typeof update.externalReply.id!=='string'||!update.externalReply.id||typeof update.externalReply.content!=='string'))return null;
 if(index<0&&!update.at)return null;
 if(index>=0&&ai.cards[index]!.status!=='running')return null;
 const cards=index<0?[...ai.cards,{id:update.id,type:update.cardType!,content:update.content,status:'running',at:update.at!,data:{root_turn_id:update.rootTurnId,source_message_id:ai.sourceMessageIds?.[0]}}]:ai.cards.map((card,i)=>i===index?{...card,content:update.content,...(update.externalReply?{data:{...(card.data as Record<string,unknown>),external_reply:update.externalReply}}:{})}:card);
 return {...previous,cursor:event.seq,ai:{...ai,cards,totalCards:ai.totalCards+(index<0?1:0)}};
}

/** Apply a phase patch and its optional prose prefix at the same event cursor. */
export function applyExternalReplyStageUpdate(previous:SessionSnapshot|null,event:SessionEvent):SessionSnapshot|null{
 const update=event.externalReplyStageUpdate,ai=previous?.ai,task=previous?.superagent?.task;
 const patch=update?.stage,reply=event.textUpdate?.externalReply;
 const stage=patch?.kind==='prose'?(reply&&reply.id===patch.id?{...patch,content:reply.content}:undefined):patch;
 if(!previous||previous.session.id!==event.sessionId||!update?.id||!update.rootTurnId||ai?.status!=='running'||
    ai.rootTurnId!==update.rootTurnId||!task||update.taskId!==(task.executionGoalId??task.taskId)||!isExternalReplyStage(stage))return null;
 if(event.seq<=previous.cursor)return previous;
 const index=ai.cards.findIndex(card=>card.id===update.id),card=ai.cards[index];
 const data=directExternalOperationData(card,update.rootTurnId);
 if(card?.status!=='running'||data?.taskId!==update.taskId)return null;
 const next=event.textUpdate?applyLiveText(previous,event):previous;
 if(!next||!next.ai||event.textUpdate&&event.textUpdate.id!==card.id)return null;
 const cards=next.ai.cards.slice(),current=cards[index]!;
 cards[index]={...current,data:{...current.data as Record<string,unknown>,
  external_reply_stages:updateExternalReplyStages(externalReplyStages(data.external_reply_stages),stage)}};
 return {...next,cursor:event.seq,ai:{...next.ai,cards}};
}
