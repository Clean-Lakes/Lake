import type {TranscriptEntry} from './timeline';
import type {ConversationGroup} from './conversation-progress-model';
import {isAssistantProse} from './completedTurnProse';

export type ResourceStages={byResource:Map<string,TranscriptEntry[]>;overall:TranscriptEntry[];ids:Set<string>};
const prose=(entry:TranscriptEntry)=>entry.card?.content??entry.message?.text??'';
const object=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'?value as Record<string,unknown>:{};
const contains=(body:string,name:string)=>{
 if(name.length<3)return false;
 const escaped=name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 const left=/[a-zA-Z0-9_.-]/.test(name[0]!)?'(^|[^a-zA-Z0-9_.-])':'';
 const right=/[a-zA-Z0-9_.-]/.test(name.at(-1)!)?'($|[^a-zA-Z0-9_.-])':'';
 return new RegExp(left+escaped+right).test(body);
};

/** A view projection only: stage text replaces the previous preview, never its
 * stored evidence. Prefer explicit identity, then exact names, then the preceding
 * resource batch. A joint result belongs to every resource in that batch;
 * unscoped narration updates the single overall progress slot below the divider. */
export function resourceStageProgress(turn:TranscriptEntry[],groups:ConversationGroup[],live:boolean,completed:boolean):ResourceStages {
 const result:ResourceStages={byResource:new Map(),overall:[],ids:new Set()};
 if(!live&&!completed||turn.some(entry=>entry.agentRun||entry.sre))return result;
 const rows=groups.filter(group=>group.progress&&group.resource);
 if(!rows.length)return result;
 const owner=new Map(rows.flatMap(group=>group.entries.map(entry=>[entry.id,group] as const)));
 let lastTool=-1;
 turn.forEach((entry,i)=>{if(entry.card&&['operation','shell'].includes(entry.card.type))lastTool=i;});
 // The real final response stays in the main reply. Failed/incomplete endings
 // must not be promoted to a successful summary.
 let final=-1;
 if(completed)turn.forEach((entry,i)=>{if(i>lastTool&&isAssistantProse(entry)&&!!prose(entry).trim()&&(!entry.card||entry.card.status==='completed'))final=i;});
 if(completed&&(lastTool<0||final<0||turn.slice(final+1).some(entry=>entry.action||entry.card?.type==='error')))return result;
 const seen=new Set<ConversationGroup>();
 let scope=new Set<ConversationGroup>(),unknown=false,hasOperation=false;
 for(const [index,entry] of turn.entries()){
  if(entry.card&&['operation','shell'].includes(entry.card.type)){
   if(!hasOperation){scope=new Set();unknown=false;}
   const row=owner.get(entry.id);
   if(row){scope.add(row);seen.add(row);}else unknown=true;
   hasOperation=true;
   continue;
  }
  if(!isAssistantProse(entry)||!prose(entry).trim()||index===final)continue;
  if(entry.card&&!['running','completed','success','succeeded'].includes(entry.card.status))continue;
  const data=object(entry.card?.data),ref=typeof data.resource_id==='string'?data.resource_id:undefined;
  const matches=[...seen].filter(row=>ref?row.resource?.id===ref:
   [row.resource?.name,row.resource?.id].some(name=>!!name&&contains(prose(entry),name)));
  const targets=matches.length?matches:!ref&&!unknown?[...scope]:[];
  if(targets.length){
   for(const target of targets){
    const key=target.entries[0]!.id,history=result.byResource.get(key)??[];
    history.push(entry);result.byResource.set(key,history);
   }
   scope=new Set(targets);unknown=false;
  } else {result.overall.push(entry);scope=new Set();unknown=true;}
  result.ids.add(entry.id);hasOperation=false;
 }
 return result;
}
