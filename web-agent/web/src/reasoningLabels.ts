import type {ReasoningSettings} from '../../shared/contracts';
export const reasoningLabels:Record<string,string>={"":"默认",none:"关闭",minimal:"极低",low:"低",medium:"中",high:"高",xhigh:"极高",max:"最高",ultra:"极致"};
/** Only show a level that belongs to this model's current capability response. */
export function currentReasoningLabel(settings:ReasoningSettings|undefined,modelId:string|null|undefined) {
 if(!modelId||settings?.modelId!==modelId||!settings.levels.length)return;
 const effort=settings.effort||settings.default;
 if(effort&&!settings.levels.includes(effort))return;
 return effort?reasoningLabels[effort]:reasoningLabels[''];
}
