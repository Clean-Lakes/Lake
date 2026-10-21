// Real settings component with fictional providers; no live settings or credentials.
import React from 'react';
import {createRoot} from 'react-dom/client';
import {ModelSettings} from '../../src/ModelSettings';
import '../../src/styles.css';
import '../../src/appSelect.css';
import '../../src/providerIcon.css';
import '../../src/extensionSettings.css';
const dark=new URLSearchParams(location.search).has('dark');
document.documentElement.dataset.theme=dark?'dark':'light';
const providers=[
 {id:'mimo',name:'小米 MiMo',baseURL:'https://api.xiaomimimo.com/v1',protocol:'openai',enabled:true,keyConfigured:false,models:['mimo-v2.6-flash','mimo-v2.6-pro'].map(id=>({id,name:id,enabled:true,supportsImageInput:false,supportsImageOutput:false}))},
 {id:'deepseek',name:'DeepSeek',baseURL:'https://api.deepseek.com/v1',protocol:'openai-response',enabled:true,keyConfigured:false,models:['deepseek-flash','deepseek-v4-pro'].map(id=>({id,name:id,enabled:true,contextWindow:1050000,supportsImageInput:true,supportsImageOutput:false}))},
];
const catalog={providers,activeProviderId:'deepseek',activeModelId:'deepseek-flash'};
window.fetch=async(input,init)=>{
 const path=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href).pathname;
 const json=(data:unknown)=>new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});
 if(init?.method&&init.method!=='GET') return json({error:'Read-only fictional fixture'});
 if(path==='/api/settings/providers')return json(catalog);
 if(path==='/api/settings/model')return json({name:'deepseek-flash',managedBy:'manual'});
 if(path==='/api/models')return json({models:[],entries:[]});
 if(path==='/api/settings/model/state')return json({providers:catalog,settings:{name:'deepseek-flash',managedBy:'manual'},available:{models:[],entries:[]}});
 return json({});
};
createRoot(document.getElementById('root')!).render(<ModelSettings onClose={()=>{}} onChanged={async()=>{}} sendShortcut="enter" onShortcutChange={()=>{}} completionEnabled={false} onCompletionEnabledChange={()=>{}} ignoreProjectMemory={false} onIgnoreProjectMemoryChange={()=>{}}/>);
