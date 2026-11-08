import {createHash} from 'node:crypto';
import type {ModelProvider, ProviderModel} from '../../web-agent/shared/contracts';
import {HttpError} from './store';
import {providerConnection} from './provider-connection';

const accepted = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const defaultLevel = 'lake_default';

/** Preserve the exact model-version registry used by internal/ai/reasoning.go.
 * This is compatibility metadata, not a network capability probe. An explicit
 * provider declaration (including an empty list) always takes precedence. */
function legacyCapability(provider: ModelProvider, model: ProviderModel) {
  const name = model.name.toLowerCase().split('/').at(-1)!;
  const is = (base: string) => name === base || name.startsWith(base + '-') && /^\d{4}-\d{2}-\d{2}$/.test(name.slice(base.length + 1));
  const api = providerConnection(provider.protocol, provider.baseURL).apiType;
  const result = (levels: string[], value?: string) => ({levels, ...(value ? {default: value} : {}), source: 'model'});
  if (provider.protocol.toLowerCase() === 'ollama' || provider.protocol.toLowerCase() === 'gemini') return undefined;
  if (['deepseek-flash', 'deepseek-pro', 'deepseek-v4-flash', 'deepseek-v4-pro'].some(is)) return result(['none', 'low', 'high', 'max'], 'high');
  if (api === 'anthropic-messages') {
    if (is('claude-opus-4-5')) return result(['low', 'medium', 'high'], 'high');
    if (['claude-opus-4-6', 'claude-sonnet-4-6'].some(is)) return result(['low', 'medium', 'high', 'max'], 'high');
    if (['claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-5', 'claude-sonnet-5', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'].some(is))
      return result(['low', 'medium', 'high', 'xhigh', 'max'], ['claude-opus-5-5', 'claude-haiku-5-5'].includes(name) ? 'medium' : 'high');
  } else {
    if (['gpt-5', 'gpt-5-mini', 'gpt-5-nano'].some(is)) return result(['minimal', 'low', 'medium', 'high']);
    if (is('gpt-5.1')) return result(['none', 'low', 'medium', 'high'], 'none');
    if (['gpt-5.2', 'gpt-5.4', 'gpt-5.5'].some(is)) return result(['none', 'low', 'medium', 'high', 'xhigh'], is('gpt-5.5') ? 'medium' : 'none');
    if (api === 'openai-responses' && ['gpt-6-astra', 'gpt-6.1-sol'].some(is)) return result(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], 'medium');
  }
  return undefined;
}

/** Unknown names never acquire support by matching a loose substring. */
export function reasoningSettings(provider?: ModelProvider, model?: ProviderModel, options: Record<string, unknown> = {}) {
  if (!provider || !model) return {modelId: '', levels: [] as string[], effort: '', supported: false};
  const modelId = createHash('sha256').update(JSON.stringify([provider.id, provider.baseURL, provider.protocol, model.id, model.name])).digest('hex');
  const api = providerConnection(provider.protocol, provider.baseURL).apiType;
  const compatible = ['openai-chat-completions', 'openai-responses', 'anthropic-messages'].includes(api);
  const metadata = model.reasoningCapability ?? legacyCapability(provider, model);
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
      : /(^|\/)claude-opus-4-5(?:$|-\d{8}$|-\d{4}-\d{2}-\d{2}$)/i.test(model.name) ? '{"output_config":{"effort":reasoningLevel}}'
        : '{"thinking":{"type":"adaptive"},"output_config":{"effort":reasoningLevel}}'
    : deepseek ? 'reasoningLevel == "none" ? {"thinking":{"type":"disabled"}} : {"thinking":{"type":"enabled"},"reasoning_effort":reasoningLevel}'
      : '{"reasoning_effort":reasoningLevel}';
  return {spec: {values: [defaultLevel, ...levels], map: `reasoningLevel == "${defaultLevel}" ? {} : (${patch})`}, value: effort || defaultLevel};
}
