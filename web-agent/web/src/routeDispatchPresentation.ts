import type {AICard} from '../../shared/contracts';
import type {TranscriptEntry} from './timeline';

import {record,routingCall,confirmsDispatch} from '../../shared/route-dispatch';
export {recoveredRouteFailures} from '../../shared/route-dispatch';

const normal=new Set(['running','completed','succeeded','success']);
const settled=new Set(['completed','succeeded','success']);
// Deliberately excludes history/evidence reads and business tools: their prose
// may contain findings, rather than just an announcement of delegation.
const handoffTools=new Set(['list_specialists','manage_specialist','search_super_tasks','route_work']);
const rootOf=(card:AICard)=>{const root=record(card.data)?.root_turn_id;return typeof root==='string'&&root.trim()?root:undefined};

/** A text-only invitation's conclusion replaces its acknowledgement in the
 * transcript. The host receipt binds the reply to the exact user and round. */
export function pilotDialogueCompletion(turn:readonly TranscriptEntry[]) {
 const user=turn[0]?.message;
 if(user?.role!=='user'||turn.some(entry=>entry.action||entry.agentRun||entry.sre||entry.message?.dispatch))return;
 const cards=turn.flatMap(entry=>entry.card?[entry.card]:[]);
 if(cards.some(card=>!rootOf(card)))return;
 const invitations=cards.filter(card=>card.type==='operation'&&card.title==='convene_specialists');
 if(invitations.length!==1)return;
 const invitation=invitations[0]!,receipt=record(invitation.content),root=rootOf(invitation);
 if(!root||!settled.has(invitation.status)||typeof receipt?.id!=='string'||!receipt.id||
   receipt.sessionId!==user.sessionId||receipt.sourceMessageId!==user.id)return;
 const invocation=cards.filter(card=>rootOf(card)===root);
 const invitationIndex=invocation.indexOf(invitation);
 if(invocation.some((card,index)=>!settled.has(card.status)||
   !['message','text','thinking'].includes(card.type)&&card!==invitation&&
   !(index<invitationIndex&&card.type==='operation'&&card.title==='list_specialists')))return;
 const acknowledgements=invocation.slice(invitationIndex+1).filter(card=>['message','text'].includes(card.type)&&card.content?.trim());
 if(acknowledgements.length!==1)return;
 const summaries=turn.flatMap(({message})=>message?.role==='assistant'&&!message.author&&!message.dispatch&&
   message.sessionId===user.sessionId&&message.conversation?.kind==='summary'&&message.conversation.summaryRequested===true&&
   message.conversation.id===receipt.id&&message.conversation.sourceMessageId===user.id&&message.text.trim()?[message]:[]);
 if(summaries.length===1)return {acknowledgement:acknowledgements[0]!,summary:summaries[0]!};
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
  if(!routes.length||operations.some(entry=>!settled.has(entry.card!.status))||routes.some(entry=>{const call=routingCall(entry.card!);return !call||!confirmsDispatch(entry.card!,call)}))continue;
  const lastTool=turn.indexOf(operations.at(-1)!);
  const final=turn.findIndex((entry,index)=>index>lastTool&&entry.card&&rootOf(entry.card)===root&&['message','text'].includes(entry.card.type)&&!!entry.card.content?.trim());
  if(final<0)continue;
  const receipts=routes.map(entry=>record(entry.card!.content)!);
  // The HTTP snapshot inserts an internal dispatch message between tool and
  // reply. Only the exact receipt's persisted forwarding metadata can bridge it.
  const internalDispatch=(entry:TranscriptEntry)=>{
   const dispatch=entry.message?.dispatch;
   return !!dispatch&&!entry.message?.author&&dispatch.sourceMessageId===user.id&&receipts.some(result=>{
    if(result.id!==dispatch.id||result.taskId!==dispatch.taskId||(result.action==='assign'?'create':result.action)!==dispatch.action)return false;
    if(Array.isArray(result.assignments))return result.assignments.some(value=>{
     const member=record(value);
     return member?.workerId===dispatch.workerId&&member.roleId===dispatch.roleId&&member.sessionId===dispatch.sessionId;
    });
    // Historical single-recipient receipts may lack the two optional identities.
    return result.workerId===dispatch.workerId&&(!result.roleId||result.roleId===dispatch.roleId)&&(!result.sessionId||result.sessionId===dispatch.sessionId);
   });
  };
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
