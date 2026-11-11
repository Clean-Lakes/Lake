import type {SessionSnapshot,SpecialistChannelEntry,SpecialistChannelPage,SuperWorker} from '../../shared/contracts';
import {liveSpecialistReplies} from '../../shared/specialist-replies';

type ChannelExecutionItem={kind:'entry';key:string;createdAt:string;entry:SpecialistChannelEntry}|
 {kind:'assignment';key:string;createdAt:string;worker:SuperWorker};

/** Assignment-only cards share the original timeline, never a trailing list of
 * all Workers. These are presentation items, not messages or execution events. */
export function channelExecutionTimeline(entries:SpecialistChannelEntry[],workers:SuperWorker[],hasOlder=false):ChannelExecutionItem[]{
 const tasks=new Set(entries.flatMap(entry=>entry.taskId?[entry.taskId]:[])),sources=new Set(entries.map(entry=>entry.sourceSessionId));
 const items:ChannelExecutionItem[]=entries.map(entry=>({kind:'entry',key:entry.id,createdAt:entry.createdAt,entry}));
 const first=entries[0]?.createdAt;
 for(const worker of workers){
  if(!worker.execution||tasks.has(worker.task.taskId)||sources.has(worker.sessionId))continue;
  const assigned=worker.execution.assignedAt||worker.createdAt||'',createdAt=Number.isFinite(Date.parse(assigned))?new Date(assigned).toISOString():'';
  const active=['queued','active'].includes(worker.assignmentState)||['running','queued','waiting_user','waiting_external'].includes(worker.task.state);
  if(hasOlder&&(!first||!createdAt||createdAt<first)&&!active)continue;
  items.push({kind:'assignment',key:JSON.stringify(['assignment',worker.id]),createdAt,worker});
 }
 return items.sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.key.localeCompare(b.key));
}

// Only exact task/source identities may share a current reply. Older SDK
// invocations remain available as history; equal prose or titles never merge.
export function currentChannelReplies(entries:SpecialistChannelEntry[]){
 const groups=new Map<string,SpecialistChannelEntry[]>();
 for(const entry of entries)if(entry.reply&&entry.taskId){
  const key=JSON.stringify([entry.taskId,entry.sourceSessionId]);
  const group=groups.get(key)??[];group.push(entry);groups.set(key,group);
 }
 const hidden=new Set<string>(),history=new Map<string,SpecialistChannelEntry[]>(),keys=new Map<string,string>();
 for(const [key,group] of groups){
  group.sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));
  const latest=group.at(-1)!;
  // Pending/unknown controls are rendered separately with the original session.
  // Never retire an actually working invocation merely because a later row exists.
  const previous=group.slice(0,-1).filter(entry=>entry.reply?.state==='settled');
  for(const entry of previous)hidden.add(entry.id);
  history.set(latest.id,previous);keys.set(latest.id,key);
 }
 return {entries:entries.filter(entry=>!hidden.has(entry.id)),history,keys};
}

export function mergeChannelEntries(previous:SpecialistChannelEntry[],incoming:SpecialistChannelEntry[]){
 const entries=new Map(previous.map(entry=>[entry.id,entry]));
 for(const entry of incoming){
  if(entries.get(entry.id)?.reply?.state==='settled'&&entry.reply?.state==='working')continue;
  entries.set(entry.id,entry);
 }
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
export function mergeChannelPage(previous:SpecialistChannelEntry[],page:Pick<SpecialistChannelPage,'entries'|'active'|'workers'|'replyPresentation'>):SpecialistChannelEntry[]{
 const durable=mergeChannelEntries(previous,page.entries);
 const byId=new Map(durable.map(entry=>[entry.id,entry]));
 const workers=new Map(page.workers.map(worker=>[worker.sessionId,worker]));
 // The host opts in explicitly. Go/older hosts may also have root IDs, but
 // their durable page still uses source-card identities and stays compatible.
 const incoming=page.replyPresentation==='invocation'?liveSpecialistReplies(page.active,page.workers):liveChannelProse(page.active);
 for(const entry of incoming){
  const current=byId.get(entry.id);
  if(current?.reply?.state==='settled'&&entry.reply?.state==='working')continue;
  // A late active snapshot cannot downgrade an already committed final card.
  if(!entry.reply&&current?.card&&current.card.status!=='running'&&entry.card?.status==='running')continue;
  const worker=workers.get(entry.sourceSessionId);
  byId.set(entry.id,{...entry,workerId:worker?.id,taskId:entry.taskId??worker?.task.taskId});
 }
 // Missing final metadata never means success. The renderer stops the reveal
 // for inactive sources; the next authoritative card supplies its real status.
 return mergeChannelEntries([],[...byId.values()]);
}
