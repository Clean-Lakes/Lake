import {createHash} from 'node:crypto';
import type {ModelProvider, ProviderModel} from '../../web-agent/shared/contracts';
import {HttpError} from './store';
import {providerConnection} from './provider-connection';

const accepted = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const defaultLevel = 'lake_default';

/** Capabilities come from saved provider metadata. Unknown model names never
 * acquire reasoning support just by matching a substring. */
export function reasoningSettings(provider?: ModelProvider, model?: ProviderModel, options: Record<string, unknown> = {}) {
  if (!provider || !model) return {modelId: '', levels: [] as string[], effort: '', supported: false};
  const modelId = createHash('sha256').update(JSON.stringify([provider.id, provider.baseURL, provider.protocol, model.id, model.name])).digest('hex');
  const api = providerConnection(provider.protocol, provider.baseURL).apiType;
  const compatible = ['openai-chat-completions', 'openai-responses', 'anthropic-messages'].includes(api);
  const metadata = model.reasoningCapability;
  const levels = compatible && Array.isArray(metadata?.levels) ? [...new Set(metadata.levels.filter(value => accepted.has(value)))] : [];
  const effort = options.reasoningModelId === modelId && typeof options.reasoningEffort === 'string' && levels.includes(options.reasoningEffort) ? options.reasoningEffort : '';
  return {modelId, levels, effort, supported: levels.length > 0,
    ...(metadata?.default && levels.includes(metadata.default) ? {default: metadata.default} : {}),
    ...(metadata?.source ? {source: metadata.source} : {})};
}

export function reasoningUpdate(provider: ModelProvider | undefined, model: ProviderModel | undefined, input: Record<string, unknown>) {
  const current = reasoningSettings(provider, model);
  if (!model) throw new HttpError(409, '请先配置可用模型');
  if (input.modelId !== current.modelId) throw new HttpError(409, '模型已切换，请重新选择思考级别');
  if (typeof input.effort !== 'string' || input.effort !== '' && !current.levels.includes(input.effort))
    throw new HttpError(400, '当前模型不支持此思考级别');
  return {reasoningModelId: current.modelId, reasoningEffort: input.effort};
}

/** Compiled by the SDK's public option-map boundary; no per-request URL or
 * fetch rewriting. Default means omit the field and keep provider behavior. */
export function reasoningBinding(provider: ModelProvider, model: ProviderModel, options: Record<string, unknown> = {}) {
  const {levels, effort} = reasoningSettings(provider, model, options);
  const {apiType} = providerConnection(provider.protocol, provider.baseURL);
  const deepseek = /(^|\/)deepseek-/i.test(model.name);
  const patch = apiType === 'openai-responses' ? '{"reasoning":{"effort":reasoningLevel}}' : apiType === 'anthropic-messages'
    ? deepseek ? 'reasoningLevel == "none" ? {"thinking":{"type":"disabled"}} : {"thinking":{"type":"enabled"},"output_config":{"effort":reasoningLevel}}'
      : /(^|\/)claude-opus-4-5(?:$|-\d{8}$)/i.test(model.name) ? '{"output_config":{"effort":reasoningLevel}}'
        : '{"thinking":{"type":"adaptive"},"output_config":{"effort":reasoningLevel}}'
    : deepseek ? 'reasoningLevel == "none" ? {"thinking":{"type":"disabled"}} : {"thinking":{"type":"enabled"},"reasoning_effort":reasoningLevel}'
      : '{"reasoning_effort":reasoningLevel}';
  return {spec: {values: [defaultLevel, ...levels], map: `reasoningLevel == "${defaultLevel}" ? {} : (${patch})`}, value: effort || defaultLevel};
}
