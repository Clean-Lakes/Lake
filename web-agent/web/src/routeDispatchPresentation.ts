import type {AICard,Message,SpecialistConversation} from '../../shared/contracts';
import type {TranscriptEntry} from './timeline';

import {record,routingCall,confirmsDispatch} from '../../shared/route-dispatch';
export {recoveredRouteFailures} from '../../shared/route-dispatch';

const normal=new Set(['running','completed','succeeded','success']);
const settled=new Set(['completed','succeeded','success']);
// Deliberately excludes history/evidence reads and business tools: their prose
// may contain findings, rather than just an announcement of delegation.
const handoffTools=new Set(['list_specialists','manage_specialist','search_super_tasks','route_work']);
const rootOf=(card:AICard)=>{const root=record(card.data)?.root_turn_id;return typeof root==='string'&&root.trim()?root:undefined};

export function confirmedRouteReceipt(card:AICard){
 const call=routingCall(card);
 return settled.has(card.status)&&call&&confirmsDispatch(card,call)?record(card.content):undefined;
}

/** Only forwarding emitted by the confirmed receipt can bridge tool prose. */
export function matchesPilotForwarding(message:Message,user:Message,receipt:Record<string,unknown>){
 const entry=message.dispatch;
 if(message.role!=='assistant'||message.author||message.sessionId!==user.sessionId||!entry||entry.sourceMessageId!==user.id||
   receipt.id!==entry.id||receipt.taskId!==entry.taskId||(receipt.action==='assign'?'create':receipt.action)!==entry.action)return false;
 if(Array.isArray(receipt.assignments))return receipt.assignments.some(value=>{
  const member=record(value);
  return member?.workerId===entry.workerId&&member.roleId===entry.roleId&&member.sessionId===entry.sessionId;
 });
 // Some older single-recipient receipts omit the optional role and session.
 return receipt.workerId===entry.workerId&&(!receipt.roleId||receipt.roleId===entry.roleId)&&(!receipt.sessionId||receipt.sessionId===entry.sessionId);
}

function dialogueAcknowledgements(turn:readonly TranscriptEntry[],user:Message,roundId:string) {
 if(turn.some(entry=>entry.action||entry.agentRun||entry.sre||entry.message?.dispatch))return;
 const cards=turn.flatMap(entry=>entry.card?[entry.card]:[]);
 if(cards.some(card=>!rootOf(card)))return;
 const invitations=cards.filter(card=>card.type==='operation'&&card.title==='convene_specialists');
 if(invitations.length!==1)return;
 const invitation=invitations[0]!,receipt=record(invitation.content),root=rootOf(invitation);
 if(!root||!settled.has(invitation.status)||receipt?.id!==roundId||
   receipt.sessionId!==user.sessionId||receipt.sourceMessageId!==user.id)return;
 const invocation=cards.filter(card=>rootOf(card)===root);
 const invitationIndex=invocation.indexOf(invitation);
 if(invocation.some((card,index)=>!settled.has(card.status)||
   !['message','text','thinking'].includes(card.type)&&card!==invitation&&
   !(index<invitationIndex&&card.type==='operation'&&card.title==='list_specialists')))return;
 return invocation.slice(invitationIndex+1).filter(card=>['message','text'].includes(card.type)&&card.content?.trim());
}

function taskAcknowledgements(turn:readonly TranscriptEntry[],taskId:string) {
 const routes=turn.filter(({card})=>{
  const receipt=card&&rootOf(card)&&confirmedRouteReceipt(card);
  return receipt&&receipt.taskId===taskId&&Array.isArray(receipt.assignments)&&receipt.assignments.length>1;
 });
 if(routes.length!==1)return;
 const route=routes[0]!,root=rootOf(route.card!);
 const after=turn.slice(turn.indexOf(route)+1).flatMap(({card})=>card&&rootOf(card)===root?[card]:[]);
 if(after.some(card=>!settled.has(card.status)||!['text','message','thinking'].includes(card.type)))return;
 return after.filter(card=>['text','message'].includes(card.type)&&card.content?.trim());
}

export type PilotSummarySlot = {
 id:string;
 round?:SpecialistConversation;
 final?:Message;
 acknowledgement?:AICard;
 acknowledgements?:AICard[];
};

/** Draft packets and the saved message claim one slot, including when either
 * the conversation snapshot or its final message arrives first. */
export function pilotSummarySlots(turn:readonly TranscriptEntry[],rounds:readonly SpecialistConversation[],replaceAcknowledgement:boolean):PilotSummarySlot[] {
 const user=turn[0]?.message;
 if(user?.role!=='user')return [];
 const slots=new Map<string,PilotSummarySlot>();
 for(const {message} of turn){
  if(message?.role!=='assistant'||message.author||message.dispatch||message.sessionId!==user.sessionId||!message.text.trim())continue;
  const dialogue=message.conversation;
  if(dialogue?.kind==='summary'&&dialogue.summaryRequested===true&&dialogue.sourceMessageId===user.id||
    message.jointReport?.kind==='summary'&&message.replyToMessageId===user.id)slots.set(message.id,{id:message.id,final:message});
 }
 for(const round of rounds){
  const id=round.summary?.id??round.summaryMessageId;
  if(!id||round.sessionId!==user.sessionId||round.sourceMessageId!==user.id||
    !['summarizing','completed'].includes(round.state))continue;
  slots.set(id,{...slots.get(id),id,round});
 }
 const claimed=new Set<string>();
 return [...slots.values()].map(slot=>{
  if(!replaceAcknowledgement)return slot;
  const {round,final}=slot;
  const taskId=round?.summary?.taskId??final?.jointReport?.taskId;
  const roundId=final?.conversation?.id??(round?.kind!=='task-summary'?round?.id:undefined);
  const acknowledgements=taskId?taskAcknowledgements(turn,taskId):roundId?dialogueAcknowledgements(turn,user,roundId):undefined;
  const acknowledgement=acknowledgements?.at(-1);
  if(!acknowledgement||claimed.has(acknowledgement.id))return slot;
  claimed.add(acknowledgement.id);
  return {...slot,acknowledgement,acknowledgements};
 });
}

/** Retire only a proven Pilot handoff preamble, after its actual reply arrives.
 * Exact SDK root and host receipt bind both packets; text similarity is never
 * evidence. Original packets remain in the execution details and saved history. */
export function pilotHandoffInterimIds(turn:readonly TranscriptEntry[]):Set<string> {
 const ids=new Set<string>();
 if(turn.filter(entry=>entry.message?.role==='user').length!==1||turn.some(entry=>entry.action||entry.agentRun||entry.sre||entry.card?.type==='error'))return ids;
 const user=turn.find(entry=>entry.message?.role==='user')!.message!;
 const cards=turn.flatMap(entry=>entry.card?[entry.card]:[]);
 // Incomplete/legacy bindings cannot safely establish a delegation-only round.
 if(cards.some(card=>!rootOf(card)))return ids;
 for(const root of new Set(cards.map(rootOf))){
  const entries=turn.filter(entry=>entry.card&&rootOf(entry.card)===root);
  if(entries.some(({card:c})=>!normal.has(c!.status)||!['message','text','thinking'].includes(c!.type)&&(c!.type!=='operation'||!handoffTools.has(c!.title??''))))continue;
  const operations=entries.filter(entry=>entry.card?.type==='operation');
  const routes=operations.filter(entry=>entry.card?.title==='route_work');
  const receipts=routes.map(entry=>confirmedRouteReceipt(entry.card!)).filter(receipt=>receipt!==undefined);
  if(!routes.length||operations.some(entry=>!settled.has(entry.card!.status))||receipts.length!==routes.length)continue;
  const lastTool=turn.indexOf(operations.at(-1)!);
  const final=turn.findIndex((entry,index)=>index>lastTool&&entry.card&&rootOf(entry.card)===root&&['message','text'].includes(entry.card.type)&&!!entry.card.content?.trim());
  if(final<0)continue;
  // The HTTP snapshot inserts an internal dispatch message between tool and
  // reply. Only the exact receipt's persisted forwarding metadata can bridge it.
  const internalDispatch=(entry:TranscriptEntry)=>!!entry.message&&receipts.some(receipt=>matchesPilotForwarding(entry.message!,user,receipt));
  // A role report, another SDK round, or an unbound message is a real boundary.
  const candidates=turn.slice(0,lastTool).filter(entry=>entry.card&&rootOf(entry.card)===root&&['message','text'].includes(entry.card.type));
  for(const entry of candidates){
   const between=turn.slice(turn.indexOf(entry)+1,final);
   if(between.some(other=>other.message&&!internalDispatch(other)||other.card&&rootOf(other.card)!==root))continue;
   ids.add(entry.id);
  }
 }
 return ids;
}
