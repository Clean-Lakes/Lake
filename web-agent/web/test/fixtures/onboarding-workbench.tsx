// First-run App integration. All state is fictional and all API calls stay in memory.
import {createRoot} from 'react-dom/client';
import App from '../../src/App';
import {setThemePreference} from '../../src/appearance';
import '../../src/styles.css';
import '../../src/appSelect.css';
import '../../src/providerIcon.css';
import '../../src/composerModelSelect.css';
import '../../src/composerCompletion.css';
import '../../src/agentQuestion.css';
const query=new URLSearchParams(location.search);
setThemePreference(query.get('theme')==='dark'?'dark':'light');
const at='2026-10-18T12:00:00Z';
let configured=query.get('setup')==='configured';
const noProject=query.has('no-project');
const hasProvider=query.get('setup')==='available'||configured;
const project={id:'demo-project',name:'演示工作区',createdAt:at};
const session={id:'demo-session',projectId:project.id,title:'新会话',status:query.get('state')==='running'?'investigating':'idle',resourceIds:[],createdAt:at,updatedAt:at,icon:'chat',tags:query.get('state')==='running'?[{id:'demo-tag',projectId:project.id,name:'演示标签',color:'purple'}]:[]};
const snapshot={session,messages:[],resources:[],resourceTree:[],actions:[],specialists:[],evidence:[],terminals:[],cursor:1,ai:{session:session.id,status:'idle',turns:0,cards:[],cardsOffset:0,totalCards:0,usage:{input:0,output:0,total:0}},messageQueue:{paused:false,revision:0,lastError:'',items:[]},sre:{enabled:false,tasks:[]}};
const model={id:'demo-model',name:'demo-model',displayName:'演示模型',enabled:true,contextWindow:64000,supportsImageInput:false,supportsImageOutput:false};
const provider={id:'demo-provider',name:'演示供应商',baseURL:'http://localhost:11434/v1',protocol:'openai',enabled:true,keyConfigured:false,models:[model]};
const selection={providerId:provider.id,providerName:provider.name,modelId:model.id,name:model.name,displayName:model.displayName};
const counts={sent:0,completions:0,selected:0,blocked:0};
function metrics(){document.getElementById('onboarding-metrics')!.textContent=JSON.stringify(counts)}
function catalog(){return {providers:hasProvider?[provider]:[],activeProviderId:configured?provider.id:'',activeModelId:configured?model.id:''}}
const original=window.fetch.bind(window);
window.fetch=async(input,init)=>{
 const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href),path=url.pathname;
 if(!path.startsWith('/api/'))return original(input,init);
 let value:unknown={};
 if(path==='/api/settings/model/select'&&init?.method==='POST'){configured=true;counts.selected++;value=catalog()}
 else if(path.endsWith('/completion')){counts.completions++;value={suffix:''}}
 else if(path.endsWith('/messages')&&init?.method==='POST'){counts.sent++;value=snapshot}
 else if((init?.method??'GET')!=='GET'){counts.blocked++;metrics();return new Response(JSON.stringify({error:'演示仅支持模型选择；不执行操作'}),{status:405,headers:{'Content-Type':'application/json'}})}
 else if(path==='/api/bootstrap')value={authenticated:true,modelConfigured:configured,modelName:configured?model.displayName:null,modelId:configured?model.id:null,modelSelection:configured?selection:null,aiRuntime:'go',terminalMode:'pty'};
 else if(path==='/api/catalog')value={projects:noProject?[]:[project],sessions:noProject?[]:[session],resources:[],resourceTree:[],tags:[],terminals:[]};
 else if(path.endsWith('/snapshot'))value=snapshot;
 else if(path==='/api/settings/providers')value=catalog();
 else if(path==='/api/settings/model')value={source:configured?'settings':'none',configured,url:'',name:configured?model.name:'',keyConfigured:false,protocol:'openai'};
 else if(path==='/api/settings/model/available')value={models:configured?[model.name]:[],entries:configured?[selection]:[]};
 else if(path.endsWith('/detect-capabilities'))value={status:'complete',total:1,complete:1};
 else if(path.endsWith('/ai/options'))value={profile:'core',silentReadFiles:true,silentWriteFiles:false,silentReadSQL:true,silentCommands:true};
 else if(path.endsWith('/ai/reasoning'))value={modelId:configured?model.id:'',levels:[],effort:''};
 else if(path.endsWith('/message-queue'))value=snapshot.messageQueue;
 else if(path.endsWith('/sre/tasks'))value={items:[],nextCursor:''};
 else if(path.endsWith('/sre'))value={enabled:false};
 else if(path.endsWith('/skills'))value={skills:[],roots:[]};
 else if(path.endsWith('/mcp'))value={servers:[]};
 else if(path.includes('/presets')||path.endsWith('/ai/references')||path.endsWith('/terminals/available'))value=[];
 metrics();return new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
};
class DemoStream extends EventTarget {static CONNECTING=0;static OPEN=1;static CLOSED=2;readyState=1;onopen:((e:Event)=>void)|null=null;onerror=null;onmessage=null;constructor(){super();queueMicrotask(()=>this.onopen?.(new Event('open')))}close(){this.readyState=2}}
window.EventSource=DemoStream as unknown as typeof EventSource;
const info=document.createElement('output');info.id='onboarding-metrics';info.hidden=true;document.body.appendChild(info);metrics();
createRoot(document.getElementById('root')!).render(<App/>);
