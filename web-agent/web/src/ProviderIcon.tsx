import {Glyph} from "./Icons";
import {providerPresets} from "./providerPresets";
import {providerBrand} from "./providerBrand";

const brands=new Set([...providerPresets.map(preset=>preset.id),"xai","meta","mistral","doubao","hunyuan","cohere","stepfun","baidu"]);
const monochrome=new Set(["xai","openai","anthropic","kimi","mimo","openrouter","ollama"]);
export function ProviderIcon({brand,name="",baseURL="",size=22}: {brand?:string;name?:string;baseURL?:string;size?:number}) {
  const id=brand || providerBrand(name,baseURL);
  return brands.has(id)
    ? <img className="provider-brand-icon" data-monochrome={monochrome.has(id)||undefined} src={`/providers/${id}.svg`} width={size} height={size} alt="" aria-hidden="true" draggable={false}/>
    : <Glyph name="plug" size={size} className="provider-brand-fallback"/>;
}
