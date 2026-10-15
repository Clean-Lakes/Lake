import type {AvailableModelEntry,AvailableModels} from "../../shared/contracts";

// Bootstrap metadata is authoritative even when a cached menu still names the old source.
export function currentComposerModel(available:AvailableModels,modelName:string|null,selection?:AvailableModelEntry):AvailableModelEntry|undefined {
  if(selection?.name===modelName) return selection;
  const active=available.entries?.find(entry=>entry.providerId===available.activeProviderId&&entry.modelId===available.activeModelId&&entry.name===modelName);
  if(active) return active;
  const matches=available.entries?.filter(entry=>entry.name===modelName)??[];
  return matches.length===1?matches[0]:undefined;
}
