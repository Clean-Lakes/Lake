import type {Resource} from '../../shared/contracts';
import type {TranscriptEntry} from './timeline';
import {transcriptGroups,transcriptTurns} from './timeline';

export type ProgressResource = {id?:string;name:string;kind?:Resource["kind"]};
export type ConversationGroup = {progress:boolean; entries:TranscriptEntry[];resource?:ProgressResource};
const normalStatuses=new Set(['running','completed','succeeded','success']);
const record=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'?value as Record<string,unknown>:{};
const text=(value:unknown)=>typeof value==='string'?value.trim():'';

// Resolve only exact, unambiguous catalog identities. A display name must never
// combine two different resources, and no connection settings enter the view.
function resourceFor(entry:TranscriptEntry,resources:Resource[]):ProgressResource|undefined {
 const card=entry.card;
 if(!card||!['operation','shell'].includes(card.type)||card.title==='ask_user_question')return;
 const data=record(card.data),args=record(data.arguments);
 const ref=text(data.resource_id)||text(args.asset_ref),target=text(data.target);
 const matches=resources.filter(resource=>ref?resource.id===ref:resource.name===target||resource.id===target);
 if(matches.length===1){const {id,name,kind}=matches[0]!;return {id,name,kind}}
 if(ref)return {id:ref,name:target||ref};
 if(target&&!['当前项目/会话','项目资源目录'].includes(target)&&!sessionFamilies[card.title??''])return {name:target};
}

// Session tools carry a generic target, but their actual scope is defined by
// the tool contract. Keep domains separate instead of folding every generic
// “current project/session” row together. Handle-based tools need a real handle.
const sessionFamilies:Record<string,string>={
 list_workflows:'workflow',get_workflow_run:'workflow',run_workflow:'workflow',save_workflow:'workflow',
 schedule_create:'schedule',schedule_list:'schedule',schedule_update:'schedule',schedule_delete:'schedule',
 todo_read:'progress',todo_write:'progress',
 list_assets:'resource-catalog',list_resource_groups:'resource-catalog',
 load_skill:'skill',read_session_context:'history',read_tool_result:'tool-result',
 task_output:'task',task_stop:'task',
 list_mcp_servers:'mcp-catalog',list_mcp_tools:'mcp-server',call_mcp_tool:'mcp-server',
};
const familyScope:Record<string,string[]>={history:['session_id'],'tool-result':['result_id'],task:['task_id'],'mcp-server':['server_id']};
function operationGroupKey(entry:TranscriptEntry,targetRefs:Map<string,Set<string>>,resource?:ProgressResource):string|undefined {
 const card=entry.card;
 if(!card||!['operation','shell'].includes(card.type)||card.title==='ask_user_question')return;
 const data=record(card.data),args=record(data.arguments),family=sessionFamilies[card.title??''];
 if(resource?.id)return JSON.stringify(['resource',resource.id]);
 if(family){
  const scope=(familyScope[family]??[]).map(key=>text(args[key]));
  if(scope.some(value=>!value))return;
  return JSON.stringify(['session-family',family,...scope,...(family==='task'?[text(args.type)]:[])]);
 }
 // Physical operations still require an established resource identity. Unknown
 // project-wide tools do not inherit a guessed family from their display text.
 const ref=text(data.resource_id)||text(args.asset_ref);
 const target=text(data.target);
 if(!ref&&(!target||['当前项目/会话','项目资源目录'].includes(target)))return;
 const refs=targetRefs.get(target);
 const identity=ref||(refs?.size===1?[...refs][0]:undefined);
 return JSON.stringify(identity?['resource',identity]:['target',target]);
}

/** One resource/family row per user turn, anchored at its first appearance.
 * Later reasoning, prose, other resources and attention states never create
 * another row for the same identity. Stored entries and child controls stay intact. */
export function conversationGroups(entries:TranscriptEntry[],resources:Resource[]=[]):ConversationGroup[] {
 const result:ConversationGroup[]=[];
 for(const turn of transcriptTurns(entries)){
  const rows=new Map<string,ConversationGroup>();
  let active:ConversationGroup|undefined,thoughts:ConversationGroup|undefined;
  // Bridge explicit asset references and context-selected operations only when
  // their recorded target identifies one unambiguous reference in this turn.
  const targetRefs=new Map<string,Set<string>>();
  for(const entry of turn){
   if(!entry.card||!['operation','shell'].includes(entry.card.type))continue;
   const data=record(entry.card.data),args=record(data.arguments),ref=text(data.resource_id)||text(args.asset_ref),target=text(data.target);
   if(ref&&target){const refs=targetRefs.get(target)??new Set<string>();refs.add(ref);targetRefs.set(target,refs)}
  }
  for(const block of transcriptGroups(turn)) {
   if(block.some(entry=>entry.agentRun)){result.push({progress:false,entries:block});continue}
   for(const entry of block){
    if(entry.card?.type==='thinking'){
     if(!entry.card.content)continue;
     const row=active??thoughts;
     if(row)row.entries.push(entry);
     else {thoughts={progress:true,entries:[entry]};result.push(thoughts)}
     continue;
    }
    const resource=resourceFor(entry,resources);
    const key=operationGroupKey(entry,targetRefs,resource);
    if(key){
     let row=rows.get(key);
     if(!row){row=thoughts??{progress:true,entries:[]};if(!thoughts)result.push(row);rows.set(key,row)}
     if(resource&&!row.resource)row.resource=resource;
     row.entries.push(entry);active=row;thoughts=undefined;
    } else result.push({progress:!!entry.card&&['operation','shell'].includes(entry.card.type),entries:[entry]});
   }
  }
 }
 return result;
}

/** Keep visible assistant prose above progress while a turn is still active.
 * Reorder only the presentation groups: stable row IDs, raw tool chronology,
 * exceptional states and decision controls remain intact. */
export function conversationDisplayGroups(entries:TranscriptEntry[],active=false,resources:Resource[]=[]):ConversationGroup[] {
 if(!active)return conversationGroups(entries,resources);
 return transcriptTurns(entries).flatMap(turn=>{
  const groups=conversationGroups(turn,resources);
  const firstProgress=groups.findIndex(group=>group.progress);
  if(firstProgress<0)return groups;
  const isProse=(group:ConversationGroup)=>!group.progress&&group.entries.every(entry=>
   entry.message?.role==='assistant'||!!entry.card&&['message','text'].includes(entry.card.type));
  const tail=groups.slice(firstProgress);
  return [...groups.slice(0,firstProgress),...tail.filter(isProse),...tail.filter(group=>!isProse(group))];
 });
}

/** Render position is anchored at first use, so find the live row by its latest
 * chronological entry rather than by the last displayed row. */
export function currentProgressGroupId(entries:TranscriptEntry[],live:boolean,resources:Resource[]=[]):string|undefined {
 if(!live)return;
 const tail=entries.filter(entry=>(entry.card?.type!=='thinking'||!!entry.card.content)&&entry.message?.role!=='assistant'&&!['message','text'].includes(entry.card?.type??'')).at(-1);
 if(!tail?.card||!normalStatuses.has(tail.card.status))return;
 const row=conversationGroups(entries,resources).find(group=>group.progress&&group.entries.some(entry=>entry.id===tail.id));
 return row?.entries[0]!.id;
}
