import type {TranscriptEntry} from './timeline';
import {transcriptGroups} from './timeline';

export type ConversationGroup = {progress:boolean; entries:TranscriptEntry[]};
const normalStatuses=new Set(['running','completed','succeeded','success']);
const record=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'?value as Record<string,unknown>:{};
const text=(value:unknown)=>typeof value==='string'?value.trim():'';

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
function operationGroupKey(entry:TranscriptEntry):string|undefined {
 const card=entry.card;
 if(!card||!['operation','shell'].includes(card.type)||!normalStatuses.has(card.status)||card.title==='ask_user_question')return;
 const data=record(card.data),args=record(data.arguments),family=sessionFamilies[card.title??''];
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
 return JSON.stringify([ref?['resource',ref]:['target',target],...['terminal_id','container_id','container'].map(key=>text(args[key]))]);
}

/** Consecutive operations on one resource or one session-tool family reuse their first row. Replies,
 * attention states and child-run controls remain explicit boundaries. */
export function conversationGroups(entries:TranscriptEntry[]):ConversationGroup[] {
 const result:ConversationGroup[]=[];
 for(const group of transcriptGroups(entries)) {
  if(group.some(entry=>entry.agentRun)){result.push({progress:false,entries:group});continue}
  for(const entry of group){
   // An invisible placeholder must not split an otherwise consecutive row.
   if(entry.card?.type==='thinking'&&!entry.card.content)continue;
   const key=operationGroupKey(entry),last=result.at(-1);
   if(key&&last?.progress&&operationGroupKey(last.entries[0]!)===key)last.entries.push(entry);
   else result.push({progress:!!entry.card&&['operation','shell'].includes(entry.card.type),entries:[entry]});
  }
 }
 return result;
}

/** Keep the current normal operation row moving while the model prepares its
 * next step. A visible reply or an attention state ends that row's live phase. */
export function currentProgressGroupId(entries:TranscriptEntry[],live:boolean):string|undefined {
 if(!live)return;
 const tail=conversationGroups(entries).at(-1);
 if(tail?.progress&&tail.entries.every(entry=>!!entry.card&&normalStatuses.has(entry.card.status)))return tail.entries[0]!.id;
}
