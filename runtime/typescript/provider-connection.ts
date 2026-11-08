import {HttpError} from './store';

/** Use the SDK's public wire adapters. Gemini and Ollama expose documented
 * OpenAI-compatible endpoints; their native base URLs are not chat endpoints. */
export function providerConnection(protocol: string, address: string) {
  const kind = protocol.trim().toLowerCase();
  const apiType = ['claude', 'anthropic', 'anthropic-messages'].includes(kind) ? 'anthropic-messages' :
    ['responses', 'openai-response', 'openai-responses'].includes(kind) ? 'openai-responses' :
      ['openai', 'openai-chat', 'openai-chat-completions', 'gemini', 'ollama'].includes(kind) ? 'openai-chat-completions' : undefined;
  if (!apiType) throw new HttpError(400, '不支持的模型协议，请选择已接入的协议');
  let url: URL; try { url = new URL(address); } catch { throw new HttpError(400, '模型地址无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new HttpError(400, '模型地址须为不包含凭据、查询参数或片段的 HTTP(S) 基础地址');
  let baseURL = url.href.replace(/\/$/, '').replace(/\/(chat\/completions|responses|messages)\/?$/, '');
  if (kind === 'gemini' && !baseURL.endsWith('/openai')) baseURL += '/openai';
  if (kind === 'ollama' && !baseURL.endsWith('/v1')) baseURL += '/v1';
  return {apiType, baseURL, modelsURL: baseURL + '/models', localKeyPlaceholder: kind === 'ollama'} as const;
}

export function modelCatalogHeaders(apiType: string, key?: string): Record<string, string> {
  return apiType === 'anthropic-messages'
    ? {'anthropic-version': '2023-06-01', ...(key ? {'x-api-key': key} : {})}
    : key ? {Authorization: `Bearer ${key}`} : {};
}
