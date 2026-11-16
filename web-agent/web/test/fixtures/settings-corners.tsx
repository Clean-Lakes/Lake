// Real settings component with fictional providers; no live settings or credentials.
import React from 'react';
import {createRoot} from 'react-dom/client';
import {ModelSettings} from '../../src/ModelSettings';
import type {GatewayConnection} from '../../../shared/contracts';
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
const projectId='settings-layout-fixture',connection:GatewayConnection={id:'fixture-client',name:'研发使用',projectId,enabled:true,routing:{mode:'pilot'},createdAt:'2026-11-16T00:00:00Z',updatedAt:'2026-11-16T00:00:00Z'};
window.fetch=async(input,init)=>{
 const path=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href).pathname;
 const json=(data:unknown)=>new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});
 if(init?.method&&init.method!=='GET') return new Response(JSON.stringify({error:'Read-only fictional fixture'}),{status:405,headers:{'Content-Type':'application/json'}});
 if(path==='/api/settings/providers')return json(catalog);
 if(path==='/api/settings/model')return json({name:'deepseek-flash',managedBy:'manual'});
 if(path==='/api/models')return json({models:[],entries:[]});
 if(path==='/api/settings/model/state')return json({providers:catalog,settings:{name:'deepseek-flash',managedBy:'manual'},available:{models:[],entries:[]}});
 if(path==='/api/settings/gateway/connections')return json({connections:[connection],command:{program:'lake',home:'/fixture/lake-dev'},projects:[{id:projectId,name:'隔离设置验收'}],specialists:[],legacyTokens:[]});
 if(path==='/api/settings/gateway/connections/fixture-client/messages')return json({messages:[]});
 if(path===`/api/projects/${projectId}/external-agents`)return json({agents:[]});
 if(path===`/api/projects/${projectId}/superagent`)return json({active:true,project:{projectId,routerSessionId:'fixture-pilot',version:1},workers:[],channels:[]});
 if(path===`/api/projects/${projectId}/watchdog`)return json({mode:'off'});
 if(path==='/api/settings/mcp')return json({servers:[]});
 if(path==='/api/settings/skills')return json({skills:[],roots:[],defaultRoot:'/fixture/skills'});
 if(path.includes('/natural-memory/')){
  if(path.endsWith('/settings'))return json({scope:{kind:'project',projectId},revision:1,autoEnabled:false,automaticReady:true,recallSettings:{revision:1,useEnabled:false},projectMemorySettings:null});
  if(path.endsWith('/status'))return json({captured:0,processed:0,deferred:0,withdrawn:0});
  return json({items:[],nextCursor:''});
 }
 return new Response(JSON.stringify({error:'Fixture blocks unknown requests'}),{status:404,headers:{'Content-Type':'application/json'}});
};
createRoot(document.getElementById('root')!).render(<ModelSettings initialTab={new URLSearchParams(location.search).get('tab')??'models'} watchdogEnabled projectId={projectId} projectName="隔离设置验收" onClose={()=>{}} onChanged={async()=>{}} sendShortcut="enter" onShortcutChange={()=>{}} ignoreProjectMemory={false} onIgnoreProjectMemoryChange={()=>{}}/>);
