// Actual App/composer with the existing fictional workspace; no live backend.
import './workspace-heading';
const inheritedFetch=window.fetch.bind(window);
const entries=[
 ...['mimo-v2.6-flash','mimo-v2.6-pro'].map(name=>({providerId:'mimo',providerName:'小米 MiMo',modelId:name,name,displayName:name})),
 ...['deepseek-flash','deepseek-v4-pro'].map(name=>({providerId:'demo-provider',providerName:'DeepSeek',modelId:name,name,displayName:name})),
];
let selected=entries[2]!;
const efforts:Record<string,string>={};
const slowSave=new URLSearchParams(location.search).has('slow-save');
const saveCalls:Array<{modelId:string;effort:string}>=[];
const saveProof=document.createElement('output');saveProof.id='reasoning-save-proof';saveProof.hidden=true;saveProof.textContent='[]';document.body.appendChild(saveProof);
const releases:Array<()=>void>=[];
const sidebarChanges:unknown[]=[];
const sidebarProof=document.createElement('output');sidebarProof.id='reasoning-sidebar-proof';sidebarProof.hidden=true;sidebarProof.textContent='[]';document.body.appendChild(sidebarProof);
if(slowSave){
 new MutationObserver(records=>{for(const record of records){const target=record.target as Element;if(target.closest('.sidebar'))sidebarChanges.push({attribute:record.attributeName,label:target.getAttribute('aria-label'),before:record.oldValue,after:target.getAttribute(record.attributeName!)});}sidebarProof.textContent=JSON.stringify(sidebarChanges);}).observe(document.body,{subtree:true,attributes:true,attributeOldValue:true,attributeFilter:['disabled','class','style']});
 document.addEventListener('keydown',event=>{if(event.key==='F7'){event.preventDefault();sidebarChanges.length=0;sidebarProof.textContent='[]';}});
}

if(slowSave)document.addEventListener('keydown',event=>{if(event.key==='F8'){event.preventDefault();releases.shift()?.();}});
const selections:unknown[]=[];
const sourceProof=document.createElement('output');sourceProof.id='model-source-proof';sourceProof.hidden=true;sourceProof.textContent='[]';document.body.appendChild(sourceProof);
window.fetch=async(input,init)=>{
 const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href);
 const json=(value:unknown)=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
 if(url.pathname==='/api/bootstrap')return json({...await (await inheritedFetch(input,init)).json(),modelName:selected.name,modelId:selected.modelId,modelSelection:selected,supportsImageInput:true});
 if(url.pathname==='/api/settings/model/available')return json({models:entries.map(m=>m.name),entries,activeProviderId:selected.providerId,activeModelId:selected.modelId,imageInputCapabilities:{'deepseek-flash':true}});
 if(url.pathname==='/api/settings/model/select'){
  const payload=JSON.parse(String(init?.body));selections.push(payload);sourceProof.textContent=JSON.stringify(selections);selected=entries.find(entry=>entry.modelId===payload.modelId)!;return json({});
 }
 if(url.pathname.endsWith('/ai/reasoning')){
  const payload=init?.method==='POST'?JSON.parse(String(init.body)):null;
  if(payload){saveCalls.push(payload);saveProof.textContent=JSON.stringify(saveCalls);if(slowSave)await new Promise<void>(resolve=>releases.push(resolve));efforts[payload.modelId]=payload.effort;}
  return json({modelId:selected.modelId,levels:selected.modelId==='deepseek-v4-pro'?['low','high']:['none','low','medium','high','max'],default:'high',effort:efforts[selected.modelId]??''});
 }
 return inheritedFetch(input,init);
};
