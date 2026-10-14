import type {ModelProvider, ModelReasoningCapability, ProviderInput, ProviderModel} from "../../shared/contracts";

export type ProviderDraft = ModelProvider & {apiKey: string; clearKey: boolean; isNew: boolean; dirty: boolean};
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
export function discoveredModels(current: ProviderModel[], names: string[], capabilities: Record<string, boolean> = {}, reasoning: Record<string, ModelReasoningCapability> = {}): ProviderModel[] {
  const seen = new Set(current.map(model => model.name));
  const result = current.map(model => {
    const detected = capabilities[model.name];
    const mode = model.imageInputMode || (model.supportsImageInput ? "on" : "auto");
    const next = typeof detected === "boolean" && mode === "auto" ? {...model, imageInputMode:"auto" as const, imageInputDetected:detected, supportsImageInput:detected} : model;
    return reasoning[model.name] ? {...next, reasoningCapability:reasoning[model.name]} : next;
  });
  for (const name of names) {
    if (!name.trim() || seen.has(name)) continue;
    seen.add(name);
    const detected = capabilities[name];
    result.push({id:crypto.randomUUID(), name, enabled:true, supportsImageInput:detected === true, supportsImageOutput:false, imageInputMode:"auto", ...(typeof detected === "boolean" ? {imageInputDetected:detected} : {}), ...(reasoning[name] ? {reasoningCapability:reasoning[name]} : {})});
  }
  return result;
}
