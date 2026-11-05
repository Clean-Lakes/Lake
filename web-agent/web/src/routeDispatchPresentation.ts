import type {AICard} from '../../shared/contracts';

function record(value:unknown):Record<string,unknown>|undefined {
 if(typeof value==='string'){try{value=JSON.parse(value)}catch{return}}
 return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
}
function routingCall(card:AICard) {
 if(card.type!=='operation'||card.title!=='route_work')return;
 const {event_id,part_key,action}=record(record(card.data)?.arguments)??{};
 if(typeof event_id!=='string'||!event_id.trim()||typeof part_key!=='string'||!part_key.trim())return;
 if(action!=='create'&&action!=='followup')return;
 return {identity:JSON.stringify([event_id,part_key]),eventId:event_id,partKey:part_key,action};
}
function confirmsDispatch(card:AICard,call:NonNullable<ReturnType<typeof routingCall>>):boolean {
 const result=record(card.content);
 if(!result||result.eventId!==call.eventId||result.partKey!==call.partKey||result.action!==call.action)return false;
 if(typeof result.workerId!=='string'||!result.workerId.trim()||typeof result.taskId!=='string'||!result.taskId.trim())return false;
 const dispatch=record(result.dispatch),state=dispatch?.state;
 // A stored decision that remains blocked or awaits the user is not recovery.
 if(state!==undefined&&!['queued','running'].includes(String(state)))return false;
 if(dispatch?.unresolvedOperations===true||typeof dispatch?.unresolvedOperations==='number'&&dispatch.unresolvedOperations>0)return false;
 return record(result.handoff)?.recorded===true||state==='queued'||state==='running';
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
