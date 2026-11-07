import type {AICard} from '../../shared/contracts';
import type {TranscriptEntry} from './timeline';

function record(value:unknown):Record<string,unknown>|undefined {
 if(typeof value==='string'){try{value=JSON.parse(value)}catch{return}}
 return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
}
const nonempty=(value:unknown):value is string=>typeof value==='string'&&!!value.trim();

function routingCall(card:AICard) {
 if(card.type!=='operation'||card.title!=='route_work')return;
 const {event_id,part_key,action,role_ids,role_id,role_key,task_id}=record(record(card.data)?.arguments)??{};
 if(!nonempty(event_id)||!nonempty(part_key)||!['create','assign','followup'].includes(String(action)))return;
 if(role_ids!=null&&(!Array.isArray(role_ids)||!role_ids.length||!role_ids.every(nonempty)||new Set(role_ids).size!==role_ids.length))return;
 const roles=Array.isArray(role_ids)?[...role_ids].sort():nonempty(role_id)?[role_id]:[];
 return {identity:JSON.stringify([event_id,part_key,action,roles,role_key,task_id]),eventId:event_id,partKey:part_key,action,roles,taskId:task_id};
}

function dispatchReady(dispatch:Record<string,unknown>|undefined,recorded:boolean) {
 const state=dispatch?.state;
 if(state!==undefined&&state!=='queued'&&state!=='running')return false;
 if(dispatch?.unresolvedOperations===true||typeof dispatch?.unresolvedOperations==='number'&&dispatch.unresolvedOperations>0)return false;
 return recorded||state==='queued'||state==='running';
}

function confirmsDispatch(card:AICard,call:NonNullable<ReturnType<typeof routingCall>>):boolean {
 const result=record(card.content);
 if(!result||result.eventId!==call.eventId||result.partKey!==call.partKey||result.action!==call.action||!nonempty(result.taskId))return false;
 if(call.taskId&&call.taskId!==result.taskId)return false;
 const recorded=record(result.handoff)?.recorded===true;
 if(result.assignments!==undefined){
  if(!Array.isArray(result.assignments)||!result.assignments.length)return false;
  const members=result.assignments.map(record);
  if(members.some(member=>!member||!nonempty(member.workerId)||!nonempty(member.sessionId)||!nonempty(member.roleId)||
   !dispatchReady(record(member.dispatch),recorded)))return false;
  for(const key of ['roleId','workerId','sessionId'])if(new Set(members.map(member=>member![key])).size!==members.length)return false;
  const roles=members.map(member=>member!.roleId).sort();
  return !call.roles.length||JSON.stringify(roles)===JSON.stringify(call.roles);
 }
 if(!nonempty(result.workerId)||call.roles.length&&(call.roles.length!==1||result.roleId!==call.roles[0]))return false;
 return dispatchReady(record(result.dispatch),recorded);
}

/** Main-flow presentation only. Input is one turn in original chronological order.
 * A later successful decision for the exact admitted event/part recovers its
 * earlier routing error; every original card remains available for inspection. */
export function recoveredRouteFailures(cards:readonly AICard[]):Set<string> {
 const succeeded=new Set<string>(),recovered=new Set<string>();
 for(let index=cards.length-1;index>=0;index--){
  const card=cards[index]!,call=routingCall(card);
  if(!call)continue;
  if(['completed','succeeded','success'].includes(card.status)&&confirmsDispatch(card,call))succeeded.add(call.identity);
  else if(card.status==='failed'&&succeeded.has(call.identity))recovered.add(card.id);
 }
 return recovered;
}

const normal=new Set(['running','completed','succeeded','success']);
const settled=new Set(['completed','succeeded','success']);
// Deliberately excludes history/evidence reads and business tools: their prose
// may contain findings, rather than just an announcement of delegation.
const handoffTools=new Set(['list_specialists','manage_specialist','search_super_tasks','route_work']);
const rootOf=(card:AICard)=>{const root=record(card.data)?.root_turn_id;return typeof root==='string'&&root.trim()?root:undefined};

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
