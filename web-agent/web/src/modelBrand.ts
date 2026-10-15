import {providerBrand} from "./providerBrand";

// Match whole model families, including routed IDs such as group/auto-gpt-6.1-sol.
const aggregators=new Set(["openrouter","siliconflow","ollama"]);
const families:[string,RegExp][]=[
  ["openai",/^(?:gpt(?:[-.\d]|$)|chatgpt(?:-|$)|o[134](?:[-\s]|$))/i],
  ["anthropic",/^claude(?:[-\s.]|$)/i],
  ["gemini",/^gemini(?:[-\s.]|$)/i],
  ["deepseek",/^deepseek(?:[-\s._]|$)/i],
  ["qwen",/^(?:qwen|qwq)(?:[-\s.\d]|$)/i],
  ["glm",/^(?:chatglm|glm)(?:[-\s.\d]|$)/i],
  ["kimi",/^(?:kimi|moonshot)(?:[-\s.]|$)/i],
  ["mimo",/^mimo(?:[-\s.]|$)/i],
  ["xai",/^grok(?:[-\s.\d]|$)/i],
  ["meta",/^llama(?:[-\s.\d]|$)/i],
  ["mistral",/^(?:mistral|mixtral|codestral|devstral|magistral|ministral|pixtral)(?:[-\s.\d]|$)/i],
  ["doubao",/^(?:doubao|seed)(?:[-\s.\d]|$)/i],
  ["hunyuan",/^hunyuan(?:[-\s._\d]|$)/i],
  ["cohere",/^command(?:[-\s.]|$)/i],
  ["stepfun",/^step(?:[-\s.\d]|$)/i],
  ["baidu",/^ernie(?:[-\s.\d]|$)/i],
  ["minimax",/^(?:minimax|abab)(?:[-\s.\d]|$)/i],
];
export function modelBrand(modelName:string,displayName="",sourceName=""):string {
  for(const [index,name] of [modelName,displayName].entries()) {
    const family=name.trim().split("/").pop()!.replace(/^auto[-_]/i,"");
    const match=(index===1&&name!==modelName?families.find(([,pattern])=>pattern.test(name.trim())):undefined)??families.find(([,pattern])=>pattern.test(family));
    if(match) return match[0];
    const owner=name.split("/")[0]!.toLowerCase();
    const ownerBrand=providerBrand(owner==="google"?"gemini":owner==="xiaomi"?"mimo":owner==="deepseek-ai"?"deepseek":owner,"");
    if(name.includes("/")&&ownerBrand!=="custom"&&!aggregators.has(ownerBrand)) return ownerBrand;
  }
  const source=providerBrand(sourceName,"");
  return aggregators.has(source)?"custom":source;
}
