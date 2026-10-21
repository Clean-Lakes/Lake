// Actual App/composer with the existing fictional workspace; no live backend.
import './workspace-heading';
const inheritedFetch=window.fetch.bind(window);
const entries=[
 ...['mimo-v2.6-flash','mimo-v2.6-pro'].map(name=>({providerId:'mimo',providerName:'小米 MiMo',modelId:name,name,displayName:name})),
 ...['deepseek-flash','deepseek-v4-pro'].map(name=>({providerId:'demo-provider',providerName:'DeepSeek',modelId:name,name,displayName:name})),
];
let selected=entries[2]!;
const efforts:Record<string,string>={};
window.fetch=async(input,init)=>{
 const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href);
 const json=(value:unknown)=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
 if(url.pathname==='/api/bootstrap')return json({...await (await inheritedFetch(input,init)).json(),modelName:selected.name,modelId:selected.modelId,modelSelection:selected,supportsImageInput:true});
 if(url.pathname==='/api/settings/model/available')return json({models:entries.map(m=>m.name),entries,activeProviderId:selected.providerId,activeModelId:selected.modelId,imageInputCapabilities:{'deepseek-flash':true}});
 if(url.pathname==='/api/settings/model/select'){
  const payload=JSON.parse(String(init?.body));selected=entries.find(entry=>entry.modelId===payload.modelId)!;return json({});
 }
 if(url.pathname.endsWith('/ai/reasoning')){
  const payload=init?.method==='POST'?JSON.parse(String(init.body)):null;
  if(payload)efforts[payload.modelId]=payload.effort;
  return json({modelId:selected.modelId,levels:selected.modelId==='deepseek-v4-pro'?['low','high']:['none','low','medium','high','max'],default:'high',effort:efforts[selected.modelId]??''});
 }
 return inheritedFetch(input,init);
};
