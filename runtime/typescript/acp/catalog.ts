import type { ExternalAgentId } from './types';
import {HttpError} from '../store';

/** External product names, not names of Lake's embedded backend. */
export const externalProducts: Record<ExternalAgentId, { name: string; version: string }> = {
  'runtime-acp': { name: 'ZCode', version: '3.17.2' },
  codex: { name: 'Codex', version: '2.2.2' },
};
export const externalAgentIds = Object.keys(externalProducts) as ExternalAgentId[];
export function externalAgentId(value: unknown): ExternalAgentId {
  if (typeof value !== 'string' || !Object.hasOwn(externalProducts, value)) throw new HttpError(400,'请选择当前支持的外部 Agent');
  return value as ExternalAgentId;
}
export const externalControlTools = new Set(['run_external_agent', 'Agent', 'Task', 'TaskOutput', 'TaskStop', 'SendMessage',
  'route_work', 'manage_specialist', 'EnterPlanMode', 'ExitPlanMode', 'AskUserQuestion']);
