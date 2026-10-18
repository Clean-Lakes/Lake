import type {TranscriptEntry} from './timeline';
import {transcriptGroups} from './timeline';

export type ConversationGroup = {progress:boolean; entries:TranscriptEntry[]};
const normal = new Set(['running','completed','succeeded','success']);
const tool = (entry:TranscriptEntry) => !!entry.card && ['operation','shell'].includes(entry.card.type);
const candidate = (entry:TranscriptEntry) => !!entry.card && normal.has(entry.card.status) && ['thinking','message','text','operation','shell'].includes(entry.card.type);

/** Presentation only: a reply followed by actual tools is commentary. Never
 * infer this from prose, hide a final reply, or cross an approval/error/turn. */
export function conversationGroups(entries:TranscriptEntry[]):ConversationGroup[] {
 const result:ConversationGroup[]=[];
 let ordinary:TranscriptEntry[]=[];
 const flush=()=>{result.push(...transcriptGroups(ordinary).map(entries=>({progress:false,entries})));ordinary=[]};
 for(let i=0;i<entries.length;){
  if(!candidate(entries[i]!)){ordinary.push(entries[i++]!);continue}
  let end=i+1;while(end<entries.length&&candidate(entries[end]!))end++;
  const block=entries.slice(i,end);
  const lastTool=block.map(tool).lastIndexOf(true);
  if(lastTool<0){ordinary.push(...block);i=end;continue}
  // Keep task dispatch cards beside their AgentTaskList rather than absorbing
  // child-run controls into an unrelated root progress strip.
  if(ordinary.at(-1)?.agentRun||entries[end]?.agentRun){ordinary.push(...block);i=end;continue}
  let split=lastTool+1;
  while(split<block.length&&block[split]!.card!.type==='thinking')split++;
  flush();
  result.push({progress:true,entries:block.slice(0,split)});
  ordinary.push(...block.slice(split));
  i=end;
 }
 flush();return result;
}
