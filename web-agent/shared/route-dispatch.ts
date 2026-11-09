import type {AICard} from "./contracts";

export function record(value:unknown):Record<string,unknown>|undefined {
 if(typeof value==='string'){try{value=JSON.parse(value)}catch{return}}
 return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
}
const nonempty=(value:unknown):value is string=>typeof value==='string'&&!!value.trim();

function stable(value:unknown):unknown {
 if(Array.isArray(value))return value.map(stable);
 return value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,stable(item)])):value;
}

export function routingCall(card:AICard) {
 if(card.type!=='operation'||card.title!=='route_work')return;
 const args=record(record(card.data)?.arguments)??{};
 const {event_id,part_key,action,role_ids,role_id,task_id}=args;
 if(!nonempty(event_id)||!nonempty(part_key)||!['create','assign','followup'].includes(String(action)))return;
 if(role_ids!=null&&(!Array.isArray(role_ids)||!role_ids.length||!role_ids.every(nonempty)||new Set(role_ids).size!==role_ids.length))return;
 const roles=Array.isArray(role_ids)?[...role_ids].sort():nonempty(role_id)?[role_id]:[];
 const {reason:_reason,...request}=args;
 if(Array.isArray(role_ids))request.role_ids=roles;
 return {identity:JSON.stringify([record(card.data)?.root_turn_id,stable(request)]),eventId:event_id,partKey:part_key,action,roles,taskId:task_id};
}

function dispatchReady(dispatch:Record<string,unknown>|undefined,recorded:boolean) {
 const state=dispatch?.state;
 if(state!==undefined&&state!=='queued'&&state!=='running')return false;
 if(dispatch?.unresolvedOperations===true||typeof dispatch?.unresolvedOperations==='number'&&dispatch.unresolvedOperations>0)return false;
 return recorded||state==='queued'||state==='running';
}

export function confirmsDispatch(card:AICard,call:NonNullable<ReturnType<typeof routingCall>>):boolean {
 const result=record(card.content);
 if(!result||result.eventId!==call.eventId||result.partKey!==call.partKey||!nonempty(result.taskId))return false;
 const recheck=call.action==='followup'&&nonempty(call.taskId)&&result.action==='create'&&result.recoveryOfTaskId===call.taskId&&result.taskId!==call.taskId&&
   Array.isArray(result.assignments)&&result.assignments.length===1&&record(result.assignments[0])?.executionId===result.taskId;
 if(!recheck&&(result.action!==call.action||call.taskId&&call.taskId!==result.taskId))return false;
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

/** Only a single missing recipient may be corrected. All other request fields,
 * including scope, quote and SDK root, must stay identical. Never infer by name. */
export function correctedSpecialistRequestKey(card:AICard):string|undefined {
 const call=routingCall(card),args=record(record(card.data)?.arguments),root=record(card.data)?.root_turn_id;
 if(!call||call.action!=='create'||!args||!nonempty(root)||!nonempty(args.role_id)||
  ['role_ids','role_key','role_instructions'].some(key=>args[key]!=null))return;
 const {role_id:_role,reason:_reason,...request}=args;
 return JSON.stringify([root,stable(request)]);
}

/** Presentation only; cards remain immutable. Corrected recipients additionally
 * require a host-verified annotation and the exact later dispatch receipt. */
export function recoveredRouteFailures(cards:readonly AICard[]):Set<string> {
 const succeeded=new Set<string>(),later=new Map<string,AICard>(),recovered=new Set<string>();
 for(let index=cards.length-1;index>=0;index--){
  const card=cards[index]!,call=routingCall(card);
  if(!call)continue;
  if(['completed','succeeded','success'].includes(card.status)&&confirmsDispatch(card,call)){
   succeeded.add(call.identity);later.set(card.id,card);
  }else if(card.status==='failed'){
   if(succeeded.has(call.identity))recovered.add(card.id);
   else {
    const proof=record(record(card.data)?.routingRecovery),success=typeof proof?.recoveredBy==='string'?later.get(proof.recoveredBy):undefined;
    const key=correctedSpecialistRequestKey(card);
    if(proof?.kind==='corrected_missing_specialist'&&success&&key&&key===correctedSpecialistRequestKey(success))recovered.add(card.id);
   }
  }
 }
 return recovered;
}
