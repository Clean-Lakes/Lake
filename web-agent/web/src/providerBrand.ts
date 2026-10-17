import {providerPresets} from "./providerPresets";

export function providerBrand(name:string,baseURL:string):string {
  try {
    const host=new URL(baseURL).host.toLowerCase();
    const preset=providerPresets.find(item=>new URL(item.baseURL).host.toLowerCase()===host);
    if (preset) return preset.id;
  } catch { /* A new custom provider may not have an endpoint yet. */ }
  const normalized=name.trim().toLowerCase();
  const preset=providerPresets.find(item=>[item.name.toLowerCase(),item.id].includes(normalized));
  return preset?.id || "custom";
}
