// Real settings component with fictional providers; no live settings or credentials.
import {useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ModelSettings} from '../../src/ModelSettings';
import {WorkspaceConsole} from '../../src/WorkspaceConsole';
import {WorkspacePageHeader} from '../../src/WorkspacePage';
import {consoleCategories, type ConsolePage} from '../../src/workspaceConsoleTabs';
import type {GatewayConnection} from '../../../shared/contracts';
import type {ExternalAgentStatus} from '../../../shared/external-agents';
import '../../src/styles.css';
import '../../src/appSelect.css';
import '../../src/providerIcon.css';
import '../../src/extensionSettings.css';
import '../../src/workspacePage.css';
const params=new URLSearchParams(location.search);
const dark=params.has('dark');
document.documentElement.dataset.theme=dark?'dark':'light';
const providers=[
 {id:'mimo',name:'小米 MiMo',baseURL:'https://api.xiaomimimo.com/v1',protocol:'openai',enabled:true,keyConfigured:false,models:['mimo-v2.6-flash','mimo-v2.6-pro'].map(id=>({id,name:id,enabled:true,supportsImageInput:false,supportsImageOutput:false}))},
 {id:'deepseek',name:'DeepSeek',baseURL:'https://api.deepseek.com/v1',protocol:'openai-response',enabled:true,keyConfigured:false,models:['deepseek-flash','deepseek-v4-pro'].map(id=>({id,name:id,enabled:true,contextWindow:1050000,supportsImageInput:true,supportsImageOutput:false}))},
];
const catalog={providers,activeProviderId:'deepseek',activeModelId:'deepseek-flash'};
const projectId=params.has('other-project')?'other-settings-fixture':'settings-layout-fixture';
const projectName=params.has('other-project')?'第二个测试项目':'隔离设置验收';
const connection:GatewayConnection={id:'fixture-client',name:'研发使用',projectId,enabled:true,routing:{mode:'pilot'},createdAt:'2026-11-16T00:00:00Z',updatedAt:'2026-11-16T00:00:00Z'};
const agentPath=`/api/projects/${projectId}/external-agents`;
const preferenceKey=`fixture-codex-overrides:${projectId}`;
const localModel='gpt-6.2-sol';
const standardEfforts=['low','medium','high','xhigh','max','ultra'];
const modelEffortOptions={
 'gpt-6.2-sol':standardEfforts,'gpt-6.2-astra':standardEfforts,'gpt-6.1-sol':standardEfforts,'gpt-6.1-terra':standardEfforts,
 'gpt-6-astra':standardEfforts,'gpt-6-sol':standardEfforts,'gpt-6-luna':standardEfforts.slice(0,-1),
 'gpt-5.6-sol':standardEfforts,'gpt-5.6-terra':standardEfforts,'gpt-5.6-luna':standardEfforts.slice(0,-1),
};
const agent:ExternalAgentStatus={id:'codex',projectId,name:'Codex',revision:1,enabled:true,installed:true,transportReady:true,assignmentReady:true,
 localModel,modelOptions:Object.keys(modelEffortOptions),modelEffortOptions,
 configPath:'/fixture/codex/config.toml',authMode:'chatgpt',updatedAt:connection.createdAt,
 ...JSON.parse(sessionStorage.getItem(preferenceKey)??'{}')};
const agentStatus=()=>{
 const model=agent.modelOverride??localModel;
 return {...agent,model,defaultTaskModel:model,reasoningEffort:agent.reasoningEffortOverride??'max'};
};
window.fetch=async(input,init)=>{
 const path=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href).pathname;
 const json=(data:unknown)=>new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});
 if(path===agentPath+'/codex/probe'&&init?.method==='POST')return json({ok:true});
 if(path===agentPath+'/codex/prepare'&&init?.method==='POST'){
  const {modelOverride,reasoningEffortOverride}=JSON.parse(String(init.body));
  Object.assign(agent,{modelOverride:modelOverride??undefined,reasoningEffortOverride:reasoningEffortOverride??undefined,revision:agent.revision+1});
  sessionStorage.setItem(preferenceKey,JSON.stringify({modelOverride:agent.modelOverride,reasoningEffortOverride:agent.reasoningEffortOverride,revision:agent.revision}));
  return json({agents:[agentStatus()]});
 }
 if(init?.method&&init.method!=='GET') return new Response(JSON.stringify({error:'Read-only fictional fixture'}),{status:405,headers:{'Content-Type':'application/json'}});
 if(path==='/api/settings/providers')return json(catalog);
 if(path==='/api/settings/model')return json({name:'deepseek-flash',managedBy:'manual'});
 if(path==='/api/models')return json({models:[],entries:[]});
 if(path==='/api/settings/model/state')return json({providers:catalog,settings:{name:'deepseek-flash',managedBy:'manual'},available:{models:[],entries:[]}});
 if(path==='/api/settings/gateway/connections')return json({connections:[connection],command:{program:'lake',home:'/fixture/lake-dev'},projects:[{id:projectId,name:'隔离设置验收'}],specialists:[],legacyTokens:[]});
 if(path==='/api/settings/gateway/connections/fixture-client/messages')return json({messages:[]});
 if(path===agentPath)return json({agents:[agentStatus()]});
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
function SettingsFixture() {
 const consoleRef=useRef<HTMLDialogElement>(null);
 const [open,setOpen]=useState(true),[busy,setBusy]=useState(false);
 const [page,setPage]=useState<ConsolePage>(()=>consoleCategories(true,'').flatMap(group=>group.items)
  .find(item=>item.key===params.get('tab'))?.key??'models');
 const close=()=>setOpen(false);
 return <>
  <main className="workspace" style={{height:'100dvh',padding:'30px'}}>
   <h1>Pilot</h1>
   <p>用测试项目验证控制台界面。</p>
   <textarea aria-label="对话草稿" defaultValue="保留正在写的草稿"/>
   <button type="button" onClick={()=>setOpen(true)}>打开控制台</button>
  </main>
  <WorkspaceConsole dialogRef={consoleRef} open={open} page={page} typescriptBackend busy={busy} onPage={setPage} onClose={close}>
   {page==='workspace'||page==='updates' ? <section className="workspace-page"><WorkspacePageHeader id="fixture-title" title={page==='workspace'?'项目':'检查更新'} onClose={close}/></section> :
    <ModelSettings tab={page} onTabChange={setPage} projectId={projectId} projectName={projectName} onClose={close}
     onBusyChange={setBusy} onChanged={async()=>{}} sendShortcut="enter" onShortcutChange={()=>{}}
     ignoreProjectMemory={false} onIgnoreProjectMemoryChange={()=>{}}/>}
  </WorkspaceConsole>
 </>;
}
createRoot(document.getElementById('root')!).render(<SettingsFixture/>);
