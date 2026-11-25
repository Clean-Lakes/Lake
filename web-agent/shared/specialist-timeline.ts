import type {AIView} from './contracts';
import {toolLabels} from './tool-labels';

export type SpecialistStep = {id:string; at:string; label:string; status:string};
export type SpecialistTimeline = {startedAt?:string; steps:SpecialistStep[]};
const stepLimit = 48;
const codexLabels:Record<string,string> = {
  commandExecution:'执行命令', fileChange:'编辑文件', collabAgentToolCall:'协作调用',
  dynamicToolCall:'调用工具', mcpToolCall:'调用 MCP 工具',
};

function actionLabel(name:unknown, fallback:string) {
  if (typeof name !== 'string') return fallback;
  if (Object.hasOwn(toolLabels,name)) return toolLabels[name]!;
  if (Object.hasOwn(codexLabels,name)) return codexLabels[name]!;
  return fallback;
}

type ToolEvent = {kind?:string; toolKind?:string; callId?:string; at?:string; title?:string; status?:string};

/** Keep the first observed clock and update the same call in place. Only display labels enter a report. */
export function externalTimelineSteps(events:readonly ToolEvent[]):SpecialistStep[] {
  const calls = new Map<string,SpecialistStep>();
  for (const event of events) {
    if ((event.kind !== 'tool' && event.kind !== 'tool_update') || !event.callId || !event.at || !Number.isFinite(Date.parse(event.at))) continue;
    const previous = calls.get(event.callId);
    if (internalTools.has(event.title ?? '')) continue;
    const toolName = event.toolKind==='mcpToolCall' && event.title && /^[A-Za-z0-9_.-]{1,80}(?: \/ [A-Za-z0-9_.-]{1,80})?$/.test(event.title) ? event.title : undefined;
    const label = actionLabel(event.title,toolName ?? previous?.label ?? actionLabel(event.toolKind,'调用工具'));
    calls.set(event.callId,{id:event.callId,at:previous?.at ?? event.at,label,status:event.status ?? previous?.status ?? 'unknown'});
  }
  return [...calls.values()].slice(-stepLimit);
}

/** Only top-level operations owned by this exact task invocation belong in its conversation. */
export function specialistTimeline(view:Pick<AIView,'cards'|'rootTurnId'|'turnStartedAt'>|undefined, taskId:string, root:string|undefined):SpecialistTimeline|undefined {
  if (!view || !root || !taskId) return;
  const steps:SpecialistStep[] = [];
  for (const card of view.cards) {
    if (card.type !== 'operation' && card.type !== 'shell') continue;
    const data = card.data as {taskId?:string; root_turn_id?:string; source?:string; agentRunId?:string; childSessionId?:string;
      external_run_id?:string; external_events?:ToolEvent[]; external_steps?:SpecialistStep[]} | undefined;
    if (data?.taskId !== taskId || data.root_turn_id !== root || data.agentRunId || data.childSessionId) continue;
    if (data.source === 'external_agent') {
      if (data.external_run_id !== card.id) continue;
      const calls = data.external_steps ?? externalTimelineSteps(data.external_events ?? []);
      for (const call of calls) steps.push({...call,id:JSON.stringify([card.id,call.id])});
    } else if (Number.isFinite(Date.parse(card.at)) && data.source !== 'native_subagent_control' && !internalTools.has(card.title ?? '')) {
      steps.push({id:card.id,at:card.at,label:actionLabel(card.title,card.type === 'shell' ? '执行命令' : '调用工具'),status:card.status});
    }
  }
  if (!steps.length) return;
  steps.sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
  const startedAt = view.rootTurnId === root ? view.turnStartedAt : undefined;
  return {startedAt, steps:steps.slice(-stepLimit)};
}

const internalTools = new Set(['work_begin','work_read','work_update','work_finish','work_wait','recall_task_context','__lake_apply_user_supplement']);
