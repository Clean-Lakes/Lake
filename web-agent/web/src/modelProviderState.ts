import type {ModelProvider, ProviderInput, ProviderModel} from "../../shared/contracts";

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
export function discoveredModels(current: ProviderModel[], names: string[]): ProviderModel[] {
  const seen = new Set(current.map(model => model.name));
  const result = [...current];
  for (const name of names) {
    if (!name.trim() || seen.has(name)) continue;
    seen.add(name);
    result.push({id:crypto.randomUUID(), name, enabled:true, supportsImageInput:false, supportsImageOutput:false});
  }
  return result;
}
