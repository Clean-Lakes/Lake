import type {TranscriptEntry} from './timeline';
import {transcriptGroups} from './timeline';

export type ConversationGroup = {progress:boolean; entries:TranscriptEntry[]};
const normalStatuses=new Set(['running','completed','succeeded','success']);
const record=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'?value as Record<string,unknown>:{};
const text=(value:unknown)=>typeof value==='string'?value.trim():'';

// Missing targets and session-wide tools cannot establish resource identity.
// Prefer stable references; preserve terminal/container scope when provided.
function resourceKey(entry:TranscriptEntry):string|undefined {
 const card=entry.card;
 if(!card||!['operation','shell'].includes(card.type)||!normalStatuses.has(card.status))return;
 const data=record(card.data),args=record(data.arguments);
 const ref=text(data.resource_id)||text(args.asset_ref);
 const target=text(data.target);
 if(!ref&&(!target||['当前项目/会话','项目资源目录'].includes(target)))return;
 return JSON.stringify([ref?['resource',ref]:['target',target],...['terminal_id','container_id','container'].map(key=>text(args[key]))]);
}

/** Consecutive operations on one resource reuse their first row. Replies,
 * attention states and child-run controls remain explicit boundaries. */
export function conversationGroups(entries:TranscriptEntry[]):ConversationGroup[] {
 const result:ConversationGroup[]=[];
 for(const group of transcriptGroups(entries)) {
  if(group.some(entry=>entry.agentRun)){result.push({progress:false,entries:group});continue}
  for(const entry of group){
   // An invisible placeholder must not split an otherwise consecutive row.
   if(entry.card?.type==='thinking'&&!entry.card.content)continue;
   const key=resourceKey(entry),last=result.at(-1);
   if(key&&last?.progress&&last.entries.every(previous=>resourceKey(previous)===key))last.entries.push(entry);
   else result.push({progress:!!entry.card&&['operation','shell'].includes(entry.card.type),entries:[entry]});
  }
 }
 return result;
}
