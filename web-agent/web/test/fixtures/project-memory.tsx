// Real UI components, synthetic local API. This fixture never calls a model or host.
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ProjectMemoryV2} from '../../src/ProjectMemoryV2';
import type {MemoryCandidate,ProjectMemoryEntry,Resource} from '../../../shared/contracts';
import '../../src/styles.css';
import '../../src/appSelect.css';

const params=new URLSearchParams(location.search);document.documentElement.dataset.theme=params.get('theme')||'light';
const settings={projectId:'memory-fixture-a',memorySchemaVersion:2,useEnabled:true,extractionEnabled:true,epoch:0,revision:2,settingsRevision:0,publishedRevision:2};
const resource={id:'node-a',projectId:settings.projectId,name:'测试环境 · 应用节点',kind:'ssh',description:'文档保留地址 192.0.2.10',status:'available'} as Resource;
let entries:ProjectMemoryEntry[]=[
 {projectId:settings.projectId,key:'release-backup',type:'project',description:'发布前核对备份的可恢复性',body:'适用条件：本项目的发布流程。\n方法：先核对最近备份，再检查维护窗口。\n再次使用时检查：当前工具和路径是否仍然适用。',revision:1,projectRevision:1,knowledgeKind:'procedure',scopeKind:'project',resourceIds:[],resourceNames:[],factKey:'release.backup',verification:'user-stated',assertedAt:'2026-10-22T08:00:00Z',validUntil:'',expired:false,deletedAt:'',createdAt:'2026-10-22T08:00:00Z',updatedAt:'2026-10-22T08:00:00Z',reviewState:'active',eligibility:'eligible',alwaysReference:true,sources:[{sourceId:'fixture-source',kind:'user',sessionId:'source-session',messageId:'source-message',assertedAt:'2026-10-22T08:00:00Z',excerpt:'请记住：本项目发布前先核对备份。'}]},
 {projectId:settings.projectId,key:'previous-port',type:'project',description:'旧版本应用曾监听 8080',body:'历史观测：版本 A 曾使用 8080。\n限制：当前版本与端口需要重新核对。',revision:1,projectRevision:2,knowledgeKind:'configuration',scopeKind:'resources',resourceIds:[resource.id],resourceNames:[resource.name],factKey:'service.port',subject:{kind:'service',identity:'fixture-api',conditions:'仅适用于版本 A'},verification:'observed',observedAt:'2026-10-20T08:00:00Z',validUntil:'2026-10-21T08:00:00Z',expired:true,deletedAt:'',createdAt:'2026-10-20T08:00:00Z',updatedAt:'2026-10-22T08:00:00Z',reviewState:'active',eligibility:'expired',sources:[{sourceId:'unavailable-source',kind:'evidence',observedAt:'2026-10-20T08:00:00Z',excerpt:'结构化来源已不可定位，保留历史摘要。'}]},
 {projectId:settings.projectId,key:'legacy-runbook',type:'project',description:'迁移来的排查方法，需要确认适用范围',body:'先核对应用日志位置，再检查关联资源。',revision:1,projectRevision:2,knowledgeKind:'procedure',scopeKind:'resources',resourceIds:[],resourceNames:[],factKey:'legacy.runbook',verification:'user-stated',validUntil:'',expired:false,deletedAt:'',createdAt:'2026-10-20T08:00:00Z',updatedAt:'2026-10-20T08:00:00Z',reviewState:'needs_review',eligibility:'needs_review'},
];
let candidates:MemoryCandidate[]=[{candidateId:'review-1',candidateHash:'fixture-hash',baseKey:'release-backup',baseRevision:1,reason:'conflict',status:'pending',createdAt:'2026-10-23T08:00:00Z',expiresAt:'2026-11-22T08:00:00Z',proposal:{...entries[0],body:'新候选：先检查维护窗口，再核对备份。'}}];
window.fetch=async(input,init)=>{
 const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href);const path=url.pathname;const method=init?.method||'GET';const data=init?.body?JSON.parse(String(init.body)):{};
 const respond=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
 if(path.includes('memory-fixture-b')) {if(path.endsWith('/memory'))return respond({settings:{...settings,projectId:'memory-fixture-b'},items:[],total:0,projectRevision:0});if(path.endsWith('/memory-candidates')||path.endsWith('/memory-jobs'))return respond({items:[]});if(path.endsWith('/memory-settings'))return respond({...settings,projectId:'memory-fixture-b'});return respond({error:'Memory not found'},404)}
 if(url.searchParams.get('query')==='延迟')await new Promise(resolve=>setTimeout(resolve,250));
 if(path.endsWith('/memory-settings')){if(method==='PATCH'){Object.assign(settings,data);settings.settingsRevision++}return respond(settings)}
 if(path.endsWith('/memory-jobs'))return respond({items:[{jobId:'job-1',status:'budget_wait',attempts:0,lastErrorCode:'daily_dispatch_limit',createdAt:'2026-10-23T08:00:00Z',usageJSON:'{}'}]});
 if(path.endsWith('/memory-candidates'))return respond({items:candidates});
 if(path.endsWith('/memory-classification')){for(const item of data.items){const entry=entries.find(value=>value.key===item.key);if(!entry||entry.revision!==item.expectedRevision)return respond({error:'Memory changed; refresh and retry'},409)}for(const item of data.items){const entry=entries.find(value=>value.key===item.key)!;Object.assign(entry,{knowledgeKind:data.knowledgeKind,scopeKind:data.scopeKind,resourceIds:data.resourceIds,reviewState:'active',eligibility:'eligible',revision:entry.revision+1})}settings.revision++;return respond({classified:data.items.length})}
 if(path.endsWith('/decision')){candidates=[];return respond({status:data.action==='accept'?'accepted':'rejected'})}
 if(path.includes('/sources/'))return respond({available:path.endsWith('fixture-source'),sessionId:'source-session',messageId:'source-message',source:entries[0].sources![0]});
 if(path.endsWith('/memory')){
  let items=entries.filter(entry=>!entry.deletedAt||url.searchParams.get('includeDeleted')==='true');const state=url.searchParams.get('reviewState'),kind=url.searchParams.get('knowledgeKind'),query=url.searchParams.get('query');
  if(state)items=items.filter(entry=>entry.eligibility===state||entry.reviewState===state);if(kind)items=items.filter(entry=>entry.knowledgeKind===kind);if(query)items=items.filter(entry=>(entry.description+entry.key).includes(query));if(url.searchParams.get('history')==='true')items=items.filter(entry=>entry.expired||entry.historical);
  return respond({settings,items,total:items.length,projectRevision:settings.revision});
 }
 const key=decodeURIComponent(path.split('/').at(-1)||'');const entry=entries.find(item=>item.key===key);
 if(method==='DELETE'&&entry){entries=entries.map(item=>item.key===key?{...item,body:'',description:'',sources:[],revision:item.revision+1,deletedAt:new Date().toISOString(),eligibility:'deleted'}:item);settings.revision++;return respond({deleted:true})}
 if(method==='PUT'){if(entry&&entry.revision!==data.expectedRevision)return respond({error:'Memory changed; refresh and retry'},409);const next={...entry,...data,key,revision:(entry?.revision||0)+1,updatedAt:new Date().toISOString(),eligibility:'eligible',reviewState:'active',deletedAt:''} as ProjectMemoryEntry;entries=entries.filter(item=>item.key!==key).concat(next);settings.revision++;return respond({revision:next.revision})}
 return entry?respond(entry):respond({error:'Memory not found'},404);
};
function Preview(){const [open,setOpen]=useState(true),[project,setProject]=useState('memory-fixture-a'),[notice,setNotice]=useState('');return <main><nav style={{display:'flex',gap:12,padding:12}}><button className="button secondary" onClick={()=>setOpen(true)}>打开记忆</button><button className="button secondary" onClick={()=>setProject(value=>value==='memory-fixture-a'?'memory-fixture-b':'memory-fixture-a')}>切换项目</button><button className="button secondary" onClick={()=>document.documentElement.dataset.theme=document.documentElement.dataset.theme==='dark'?'light':'dark'}>切换主题</button></nav><p role="status">{notice}</p>{open&&<ProjectMemoryV2 key={project} project={{id:project,name:project.endsWith('a')?'示例运维项目':'第二项目',createdAt:''}} resources={[resource]} onClose={()=>setOpen(false)} onOpenSource={(session,id)=>{setNotice(`已定位来源 ${session}/${id}`);setOpen(false)}}/>}</main>}
createRoot(document.getElementById('root')!).render(<Preview/>);
