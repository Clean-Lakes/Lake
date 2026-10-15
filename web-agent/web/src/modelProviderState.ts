import type {ModelProvider, ModelReasoningCapability, ProviderInput, ProviderModel} from "../../shared/contracts";

export type ProviderDraft = ModelProvider & {apiKey: string; clearKey: boolean; isNew: boolean; dirty: boolean};
export function providerProtocolBaseURL(base: string, protocol: string): string {
  try {
    const url = new URL(base);
    if (url.protocol !== "https:" || url.username || url.password || url.port || !["api.xiaomimimo.com", "token-plan-cn.xiaomimimo.com"].includes(url.hostname)) return base;
    if (!["", "/v1", "/v1/messages", "/v1/chat/completions", "/v1/responses", "/anthropic", "/anthropic/v1", "/anthropic/v1/messages"].includes(url.pathname.replace(/\/+$/, ""))) return base;
    if (protocol === "claude") url.pathname = "/anthropic/v1";
    else if (["openai", "openai-response"].includes(protocol)) url.pathname = "/v1";
    else return base;
    return url.toString();
  } catch { return base; }
}
export function providerDraft(provider: ModelProvider): ProviderDraft {
  return {...provider, models: provider.models.map(model => ({...model})), apiKey:"", clearKey:false, isNew:false, dirty:false};
}
export function providerPayload(draft: ProviderDraft): ProviderInput {
  return {name:draft.name.trim(), baseURL:draft.baseURL.trim(), protocol:draft.protocol, enabled:draft.enabled,
    models:draft.models.map(model => ({...model, name:model.name.trim(), displayName:model.displayName?.trim()})),
    ...(draft.clearKey ? {apiKey:null} : draft.apiKey.trim() ? {apiKey:draft.apiKey} : {})};
}
export function contextLabel(value?: number): string {
  if (!value) return "自动";
  if (value >= 1_000_000) return `${+(value / 1_000_000).toFixed(2)}M`;
  return `${+(value / 1_000).toFixed(1)}K`;
}
export function discoveredModels(current: ProviderModel[], names: string[], capabilities: Record<string, boolean> = {}, reasoning: Record<string, ModelReasoningCapability> = {}, contextLimits: Record<string, number> = {}): ProviderModel[] {
  const seen = new Set(current.map(model => model.name));
  const wanted = new Set(names);
  const result = current.map(model => {
    if (!wanted.has(model.name)) return model;
    const detected = capabilities[model.name];
    const mode = model.imageInputMode || (model.supportsImageInput ? "on" : "auto");
    const next = typeof detected === "boolean" && mode === "auto" ? {...model, imageInputMode:"auto" as const, imageInputDetected:detected, supportsImageInput:detected} : model;
    return reasoning[model.name] ? {...next, reasoningCapability:reasoning[model.name]} : next;
  });
  for (const name of names) {
    if (!name.trim() || seen.has(name)) continue;
    seen.add(name);
    const detected = capabilities[name];
    const limit = contextLimits[name];
    const contextWindow = limit && Number.isInteger(limit) && limit >= 2048 && limit <= 2_000_000 ? limit : 0;
    result.push({id:crypto.randomUUID(), name, contextWindow, enabled:true, supportsImageInput:detected === true, supportsImageOutput:false, imageInputMode:"auto", ...(typeof detected === "boolean" ? {imageInputDetected:detected} : {}), ...(reasoning[name] ? {reasoningCapability:reasoning[name]} : {})});
  }
  return result;
}
