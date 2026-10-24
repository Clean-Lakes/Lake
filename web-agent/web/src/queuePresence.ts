import type {QueuedMessage} from '../../shared/contracts';

export type QueuePresence={item:QueuedMessage;phase:'present'|'entering'|'leaving'};

// Retiring rows are presentation only; callers must always act on the live queue.
export function reconcileQueuePresence(previous:QueuePresence[],items:QueuedMessage[],animate:boolean):QueuePresence[] {
 const existing=new Map(previous.map(row=>[row.item.id,row]));
 const rows:QueuePresence[]=items.map(item=>{
  const prior=existing.get(item.id);
  return {item,phase:!animate?'present':!prior||prior.phase==='leaving'?'entering':prior.phase};
 });
 if(animate){
  const live=new Set(items.map(item=>item.id));
  previous.forEach((row,index)=>{if(!live.has(row.item.id))rows.splice(Math.min(index,rows.length),0,{item:row.item,phase:'leaving'});});
 }
 return rows;
}
