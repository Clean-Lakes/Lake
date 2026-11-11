import {pilotConfigurationToolNames} from '../configuration-tool-names';
import type { ExternalAgentId } from './types';
import {HttpError} from '../store';
import {externalAgentNames} from '../../../web-agent/shared/external-agents';

/** External product names, not names of Lake's embedded backend. */
export const externalProducts: Record<ExternalAgentId, { name: string; version: string }> = {
  codex: { name: externalAgentNames.codex, version: '2.2.2' },
};
export const externalAgentIds = Object.keys(externalProducts) as ExternalAgentId[];
export function externalAgentId(value: unknown): ExternalAgentId {
  if(value==='runtime-acp')throw new HttpError(409,'该外部 Agent 已移除；请为新任务选择 Codex。历史执行不会重放或切换后端。');
  if (typeof value !== 'string' || !Object.hasOwn(externalProducts, value)) throw new HttpError(400,'请选择当前支持的外部 Agent');
  return value as ExternalAgentId;
}
export const externalControlTools = new Set([...pilotConfigurationToolNames,'run_external_agent', 'Agent', 'Task', 'TaskOutput', 'TaskStop', 'SendMessage',
  'route_work', 'manage_specialist', 'EnterPlanMode', 'ExitPlanMode', 'AskUserQuestion']);
