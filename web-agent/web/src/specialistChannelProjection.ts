import type {SessionSnapshot,SpecialistChannelEntry,SpecialistChannelPage} from '../../shared/contracts';

export function mergeChannelEntries(previous:SpecialistChannelEntry[],incoming:SpecialistChannelEntry[]){
 const entries=new Map(previous.map(entry=>[entry.id,entry]));
 for(const entry of incoming)entries.set(entry.id,entry);
 return [...entries.values()].sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));
}

/** Same source identity as the host's durable channel projection. */
export const channelCardEntryId=(sessionId:string,cardId:string)=>JSON.stringify(['card',sessionId,cardId]);
export function liveChannelProse(active:SessionSnapshot[]):SpecialistChannelEntry[]{
 return active.flatMap(snapshot=>{
  const start=snapshot.ai?.turnStartedAt;
  if(!start)return [];
  return (snapshot.ai?.cards??[]).filter(card=>['message','text'].includes(card.type)&&!!card.content?.trim()&&card.at>=start).map(card=>({
   id:channelCardEntryId(snapshot.session.id,card.id),sourceSessionId:snapshot.session.id,
   taskId:snapshot.superagent?.task.taskId,createdAt:card.at,card,
  }));
 });
}

/** Keep publicly shown prose in one list through streaming, settlement and paging. */
export function mergeChannelPage(previous:SpecialistChannelEntry[],page:Pick<SpecialistChannelPage,'entries'|'active'|'workers'>):SpecialistChannelEntry[]{
 const durable=mergeChannelEntries(previous,page.entries);
 const byId=new Map(durable.map(entry=>[entry.id,entry]));
 const workers=new Map(page.workers.map(worker=>[worker.sessionId,worker]));
 for(const entry of liveChannelProse(page.active)){
  const current=byId.get(entry.id);
  // A late active snapshot cannot downgrade an already committed final card.
  if(current?.card&&current.card.status!=='running'&&entry.card?.status==='running')continue;
  const worker=workers.get(entry.sourceSessionId);
  byId.set(entry.id,{...entry,workerId:worker?.id,taskId:entry.taskId??worker?.task.taskId});
 }
 // Missing final metadata never means success. The renderer stops the reveal
 // for inactive sources; the next authoritative card supplies its real status.
 return mergeChannelEntries([],[...byId.values()]);
}
