// Exercise the actual transparent native content and bridge, with in-memory API responses only.
import {createRoot} from 'react-dom/client';
import {NativeModelPanelPage} from '../../src/NativeModelPanelPage';
import type {NativeModelPanelState} from '../../src/nativeModelPanel';
import '../../src/styles.css';
import '../../src/appSelect.css';
import '../../src/providerIcon.css';
import '../../src/composerModelSelect.css';
const entries=[
 {providerId:'mimo',providerName:'小米 MiMo',modelId:'mimo-v2.6-flash',name:'mimo-v2.6-flash',displayName:'mimo-v2.6-flash'},
 {providerId:'mimo',providerName:'小米 MiMo',modelId:'mimo-v2.6-pro',name:'mimo-v2.6-pro',displayName:'mimo-v2.6-pro'},
 {providerId:'deepseek',providerName:'DeepSeek',modelId:'deepseek-flash',name:'deepseek-flash',displayName:'deepseek-flash'},
 {providerId:'deepseek',providerName:'DeepSeek',modelId:'deepseek-v4-pro',name:'deepseek-v4-pro',displayName:'deepseek-v4-pro'},
];
const state:NativeModelPanelState={id:'fixture',presentation:1,available:{models:entries.map(entry=>entry.name),entries,loading:false},modelName:'deepseek-flash',selection:entries[2],disabled:false,theme:new URLSearchParams(location.search).has('dark')?'dark':'light',anchor:{left:500,top:600,width:150,height:28},reasoning:{session:'demo',modelId:'deepseek-flash',disabled:false}};
const proof=document.createElement('output');proof.id='native-panel-proof';proof.hidden=true;document.body.appendChild(proof);
const events:Record<string,unknown>[]=[],posts:unknown[]=[];
const record=()=>{proof.textContent=JSON.stringify({events,posts});};record();
const send=()=>window.dispatchEvent(new CustomEvent('lake-native-model-state',{detail:{...state}}));
window.lakeNativeModelPanel={role:'panel',command:async message=>{
 events.push(message);record();
 if(message.action==='ready')queueMicrotask(send);
 if(message.action==='providers')return (message.providers as {id:string}[]).find(provider=>provider.id!==message.value)?.id??null;
 if(message.action==='event') {
  const event=message.event as {kind:string;saving?:boolean};
  if(event.kind==='saving') {state.disabled=!!event.saving;send();}
 }
 return true;
}};
const gates:Array<()=>void>=[];
window.addEventListener('keydown',event=>{if(event.key==='F8'){event.preventDefault();gates.shift()?.();}});
let effort='low';
window.fetch=async(input,init)=>{
 const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href);
 if(!url.pathname.endsWith('/ai/reasoning'))return new Response('{}',{status:404});
 if(init?.method==='POST') {const body=JSON.parse(String(init.body));posts.push(body);record();await new Promise<void>(resolve=>gates.push(resolve));effort=body.effort;}
 return new Response(JSON.stringify({modelId:'deepseek-flash',effort,default:'high',levels:['none','low','medium','high','max']}),{headers:{'Content-Type':'application/json'}});
};
createRoot(document.getElementById('root')!).render(<NativeModelPanelPage/>);
