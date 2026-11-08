import type {Resource} from "../../web-agent/shared/contracts";
import {LakeStore} from "./store";
import {digest} from "./tasks";

type ResourceIdentity = Pick<Resource,"id"|"projectId">;
type Pin = {resourceId:string; projectId:string; revision:string};

/** Short copyable references for model tool input. The full connection revision
 * is stored, compared and audited by the host. A prefix is never a valid pin. */
export function issueResourcePin(store:LakeStore, resource:ResourceIdentity, revision:string) {
  const key="pin_"+digest([resource.projectId,resource.id,revision]).slice(0,12);
  const original=store.get<Pin>("resourceConfigurationPins",key);
  if(original) return original.projectId===resource.projectId && original.resourceId===resource.id && original.revision===revision ? key : undefined;
  store.put<Pin>("resourceConfigurationPins",key,{resourceId:resource.id,projectId:resource.projectId,revision});
  return key;
}
export function boundResourceRevision(store:LakeStore, resource:ResourceIdentity, supplied:unknown, current:string) {
  if(supplied===current) return true;
  if(typeof supplied!=="string" || !/^pin_[a-f0-9]{12}$/.test(supplied)) return false;
  const pin=store.get<Pin>("resourceConfigurationPins",supplied);
  return !!pin && pin.projectId===resource.projectId && pin.resourceId===resource.id && pin.revision===current;
}
