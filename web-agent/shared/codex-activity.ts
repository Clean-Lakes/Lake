import type {AIView} from './contracts';

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

/** A public transcript belongs only to the recorded root Worker invocation. */
export function codexActivity(view:Pick<AIView,'cards'>|undefined,taskId:string|undefined,root:string|undefined){
  if(!view||!taskId||!root)return [];
  return view.cards.flatMap(card=>{
    const data=card.data as {source?:string;external_agent?:string;external_run_id?:string;taskId?:string;root_turn_id?:string;agentRunId?:string;childSessionId?:string;codex_activity?:CodexActivityItem[]}|undefined;
    if(card.type!=='operation'||data?.source!=='external_agent'||data.external_agent!=='codex'||data.external_run_id!==card.id||
        data.taskId!==taskId||data.root_turn_id!==root||data.agentRunId||data.childSessionId||!Array.isArray(data.codex_activity))return [];
    return data.codex_activity.map(item=>item.kind!=='text'&&item.status==='running'&&card.status!=='running'?
      {...item,status:'unknown' as const}:item);
  }).slice(-64);
}
