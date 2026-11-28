import type {AIView} from './contracts';
import {isExternalAgentId} from './external-agents';

export type CodexAction = 'command'|'read'|'edit'|'integration'|'task';
export type CodexTaskState = 'pending'|'in_progress'|'completed'|'removed';
export type CodexActivityItem =
  | {kind:'text'; id:string; text:string}
  | {kind:CodexAction; id:string; text:string; status:'running'|'completed'|'failed'|'stopped'|'unknown'; at:string; createdTask?:boolean; taskState?:CodexTaskState; output?:string; endedAt?:string};

export function updateCodexActivity(items:readonly CodexActivityItem[], item:CodexActivityItem):CodexActivityItem[] {
  const index=items.findIndex(previous=>previous.id===item.id);
  if(index<0)return [...items.slice(-63),item];
  const next=items.slice();
  next[index]=item;
  return next;
}

export function activityCallStatus(status:unknown):Exclude<CodexActivityItem,{kind:'text'}>['status']{
  if(status==='pending'||status==='in_progress'||status==='running')return 'running';
  if(status==='completed'||status==='failed')return status;
  return status==='cancelled'||status==='declined'||status==='interrupted'||status==='stopped'?'stopped':'unknown';
}

/** Older Antigravity updates saved only a tool title and status. */
function recordedAntigravityCalls(runId:string,events:unknown){
  if(!Array.isArray(events))return [];
  const calls=new Map<string,Exclude<CodexActivityItem,{kind:'text'}>>();
  for(const event of events){
    if((event?.kind!=='tool'&&event?.kind!=='tool_update')||typeof event.callId!=='string'||!event.callId||typeof event.at!=='string')continue;
    const previous=calls.get(event.callId),status=activityCallStatus(event.status);
    if(previous&&previous.status!=='running'&&status==='running')continue;
    const text=previous?.text??(typeof event.title==='string'&&event.title.trim()?event.title.slice(0,240):'调用工具');
    calls.set(event.callId,{kind:'integration',id:JSON.stringify([runId,event.callId]),text,status,at:previous?.at??event.at,
      ...(status!=='running'&&{endedAt:previous?.endedAt??event.at})});
  }
  return [...calls.values()];
}

/** A public transcript belongs only to the recorded root Worker invocation. */
export function specialistActivity(view:Pick<AIView,'cards'>|undefined,taskId:string|undefined,root:string|undefined){
  if(!view||!taskId||!root)return [];
  return view.cards.flatMap(card=>{
    const data=card.data as {source?:string;external_agent?:string;external_run_id?:string;taskId?:string;root_turn_id?:string;agentRunId?:string;childSessionId?:string;
      codex_activity?:CodexActivityItem[];external_events?:unknown}|undefined;
    if(card.type!=='operation'||data?.source!=='external_agent'||!isExternalAgentId(data.external_agent)||data.external_run_id!==card.id||
        data.taskId!==taskId||data.root_turn_id!==root||data.agentRunId||data.childSessionId)return [];
    const items=Array.isArray(data.codex_activity)?data.codex_activity:
      data.external_agent==='antigravity'?recordedAntigravityCalls(card.id,data.external_events):[];
    return items.map(item=>item.kind!=='text'&&item.status==='running'&&card.status!=='running'?
      {...item,status:'unknown' as const}:item);
  }).slice(-64);
}
