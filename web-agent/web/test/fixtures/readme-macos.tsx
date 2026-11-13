// README v0.3.33: shipping React UI with fictional, read-only API records.
// The macOS presentation frame is not a native OS capture. No Lake home is used.
import {createRoot} from 'react-dom/client';
import App from '../../src/App';
import {setThemePreference} from '../../src/appearance';
import '../../src/theme.css';
import '../../src/appSelect.css';
import '../../src/providerIcon.css';
import '../../src/composerModelSelect.css';
import '../../src/composerCompletion.css';
import '../../src/agentQuestion.css';
import '../../src/sreCollaboration.css';
import './readme-macos.css';
import type {Message,Resource,ResourceTreeNode,SessionSnapshot,SpecialistChannelInfo,SpecialistChannelPage,SuperWorker,WorkSession} from '../../../shared/contracts';

const fallback=window.fetch.bind(window),projectId='demo-project',pilot='demo-session-0',at='2026-11-13T02:10:00Z';
setThemePreference(new URLSearchParams(location.search).get('theme')==='dark'?'dark':'light');
const model={id:'readme-model',providerId:'readme-provider',providerName:'OpenAI',modelId:'gpt-6.1-sol',name:'gpt-6.1-sol',displayName:'gpt-6.1-sol',protocol:'openai'};
const project={id:projectId,name:'Northwind · 演示环境',createdAt:at};
const resources:Resource[]=[
 {id:'order-api',name:'订单服务 · order-api',kind:'ssh',description:'演示应用节点'},
 {id:'gateway',name:'入口网关 · edge-01',kind:'ssh',description:'演示入口网关'},
 {id:'postgres',name:'订单数据库 · PostgreSQL',kind:'database',description:'演示订单数据库'},
 {id:'redis',name:'缓存 · Redis',kind:'redis',description:'演示会话缓存'},
 {id:'cluster',name:'业务集群 · Kubernetes',kind:'kubernetes',description:'演示业务集群'},
].map(resource=>({...resource,projectId,status:'available'})) as Resource[];
const resourceTree:ResourceTreeNode[]=[
 {id:'apps',projectId,parentId:null,kind:'folder',name:'应用服务',resourceId:null,position:0},
 {id:'data',projectId,parentId:null,kind:'folder',name:'数据服务',resourceId:null,position:1},
 ...resources.map((resource,index)=>({id:`node-${resource.id}`,projectId,parentId:['postgres','redis'].includes(resource.id)?'data':'apps',kind:'resource' as const,name:resource.name,resourceId:resource.id,position:index})),
];
const read={cursor:'00000000000000000001',seenCursor:'00000000000000000001'};
const channels:SpecialistChannelInfo[]=[
 {roleName:'服务器运维专员',duties:'负责服务器与 Kubernetes 巡检、日志查询和故障排查。',avatarId:'heron',execution:{kind:'acp',agent:'codex',revision:1}},
 {roleName:'发布专员',duties:'负责发布记录查询、应用版本核对与发布事务。',avatarId:'kingfisher',execution:{kind:'native'}},
 {roleName:'数据库专员',duties:'负责数据库运行状态、连接与备份检查。',avatarId:'otter',execution:{kind:'acp',agent:'codex',revision:1}},
 {roleName:'知识库专员',duties:'负责知识库查询、文档检索与运维资料整理。',avatarId:'beaver',execution:{kind:'native'}},
].map((channel,index)=>({...channel,id:`readme-channel-${index}`,roleId:`readme-role-${index}`,sessionId:`demo-session-${index+1}`,projectId,revision:1,roleRevision:1,createdAt:at,messageRead:{...read}})) as SpecialistChannelInfo[];
const titles=['检查订单服务与主机状态','查询最近一次订单服务发布','核对数据库连接与慢查询','复查应用节点磁盘容量','查询网关最近的重启记录','核对业务集群节点状态'];
const reports=[
 '订单服务 3 个实例均在线，CPU 与内存处于正常范围。最近 15 分钟没有新的重启或磁盘告警。',
 '最近一次发布为 v2.8.1，相关实例已就绪。当前没有正在执行的发布任务。',
 '数据库连接数为 28 / 200，未发现长事务或锁等待。连接来源与订单服务节点一致。',
];
const workers:SuperWorker[]=titles.map((title,index)=>{
 const channel=channels[index<3?index:0],createdAt=new Date(Date.parse(at)-(index<3?0:(index-2)*86_400_000)).toISOString();
 return {id:`readme-worker-${index}`,sessionId:`readme-task-session-${index}`,roleId:channel.roleId,roleName:channel.roleName,createdAt,assignmentState:'parked',
  task:{taskId:`readme-task-${index}`,sessionId:`readme-task-session-${index}`,projectId,title,state:'completed',acceptanceState:'not_evaluated',revision:1,originRootTurnId:`readme-task-root-${index}`,deadlineAt:'2026-11-13T03:00:00Z',updatedAt:createdAt,resources:[],summary:reports[index]??'演示检查记录已保存。'},
  execution:{backend:channel.execution!,source:'task_assignment',assignedAt:createdAt,totalRuns:channel.execution?.kind==='acp'?1:0,runs:channel.execution?.kind==='acp'?[{id:`readme-run-${index}`,agent:'codex',scope:'worker',state:'completed',dispatchPhase:'answered',createdAt,updatedAt:createdAt,usage:null}]:[]}};
});
const sessions:WorkSession[]=[{id:pilot,projectId,title:'Pilot',workspaceRole:'router',status:'completed',resourceIds:[],createdAt:at,updatedAt:at,icon:'chat',tags:[]},
 ...channels.map(channel=>({id:channel.sessionId,projectId,title:channel.roleName,workspaceRole:'role',status:'completed',resourceIds:[],createdAt:at,updatedAt:at,icon:'chat',tags:[]})),
 ...workers.map(worker=>({id:worker.sessionId,projectId,title:worker.task.title,workspaceRole:'worker',status:'completed',resourceIds:[],createdAt:worker.createdAt!,updatedAt:worker.createdAt!,icon:'chat',tags:[]}))] as WorkSession[];
const messages:Message[]=[
 {id:'readme-question',sessionId:pilot,role:'user',text:'请三位专员分别只读核对订单服务、近期发布和数据库连接，结果直接在这里回复。',createdAt:at},
 {id:'readme-pilot-reply',sessionId:pilot,role:'assistant',text:'已交给服务器、发布和数据库专员，各自核对后会在这里回复。',createdAt:at},
 ...reports.map((text,index)=>({id:`readme-report-${index}`,sessionId:pilot,role:'assistant' as const,text,createdAt:new Date(Date.parse(at)+(index+1)*10_000).toISOString(),author:{kind:'specialist' as const,name:channels[index].roleName,roleId:channels[index].roleId,workerId:workers[index].id,sessionId:workers[index].sessionId,taskId:workers[index].task.taskId,channelSessionId:channels[index].sessionId,rootTurnId:'readme-turn',execution:channels[index].execution,avatarId:channels[index].avatarId}})),
];
function snapshot(session:WorkSession):SessionSnapshot{
 const worker=workers.find(worker=>worker.sessionId===session.id);
 const transcript:Message[]=worker?[{id:`${worker.id}-report`,sessionId:worker.sessionId,role:'assistant',text:worker.task.summary!,createdAt:worker.createdAt!}]:[];
 return {session,resources,resourceTree,messages:session.id===pilot?messages:transcript,specialists:[],evidence:[],actions:[],terminals:[],cursor:1,
  ...(worker?{superagent:{task:worker.task,roleId:worker.roleId,execution:worker.execution}}:{}),
  messageQueue:{paused:false,revision:0,lastError:'',items:[]},sre:{featureVersion:1,enabled:false,tasks:[]},
  ai:{session:session.id,profile:'core',status:'completed',turns:1,rootTurnId:worker?.task.originRootTurnId??'readme-turn',turnStartedAt:at,turnFinishedAt:'2026-11-13T02:10:30Z',cards:[],cardsOffset:0,totalCards:0,agentRuns:[],usage:{known:false,input:0,output:0,total:0}}};
}
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const requests:string[]=[],rejectedWrites:string[]=[];
Object.assign(window,{lakeReadmeCapture:{version:'0.3.33',requests,rejectedWrites,fictional:true}});
window.lakeDesktopUpdates={platform:'macOS · Apple Silicon',command:async()=>({status:'current',currentVersion:'0.3.33',message:'当前已是最新版本',updateAvailable:false})};
window.fetch=async(input,init)=>{
 const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href),path=url.pathname;
 if(!path.startsWith('/api/'))return fallback(input,init);
 requests.push(path);
 const method=init?.method??(input instanceof Request?input.method:'GET');
 if(method!=='GET'){rejectedWrites.push(path);return json({error:'README 演示仅展示虚构记录，不执行操作'},405);}
 if(path==='/api/bootstrap')return json({authenticated:true,modelConfigured:true,modelName:model.name,modelId:model.modelId,modelSelection:model,terminalMode:'pty',supportsImageInput:false,backendRuntime:'typescript',aiRuntime:'typescript'});
 if(path==='/api/catalog')return json({projects:[project],sessions,resources,resourceTree,tags:[],terminals:[]});
 if(path.endsWith('/superagent'))return json({active:true,project:{projectId,routerSessionId:pilot,version:1},channels,workers,cursor:1,pilotMessageRead:read});
 if(path.endsWith('/external-agents'))return json({agents:[{id:'codex',name:'Codex',projectId,revision:1,enabled:true,installed:true,transportReady:true,assignmentReady:true,model:model.name,authMode:'chatgpt',updatedAt:at}]});
 if(path.endsWith('/snapshot'))return json(snapshot(sessions.find(session=>session.id===path.split('/')[3])??sessions[0]));
 if(path.endsWith('/channel')){
  const channel=channels.find(channel=>channel.sessionId===path.split('/')[3])??channels[0];
  const page:SpecialistChannelPage={channel,workers:workers.filter(worker=>worker.roleId===channel.roleId),entries:[],active:[],routing:false,queued:0,nextCursor:'',replyPresentation:'invocation'};
  return json(page);
 }
 if(path.endsWith('/sre'))return json({enabled:false});
 if(path.endsWith('/sre/tasks'))return json({items:[],nextCursor:''});
 if(path.endsWith('/ai/reasoning'))return json({modelId:model.modelId,effort:'',default:'medium',levels:['low','medium','high']});
 if(path==='/api/settings/model/available')return json({models:[model.name],entries:[model],activeProviderId:model.providerId,activeModelId:model.modelId});
 if(path==='/api/settings/model/state')return json({modelConfigured:true,modelName:model.name,modelId:model.modelId,modelSelection:model,supportsImageInput:false,available:{models:[model.name],entries:[model],activeProviderId:model.providerId,activeModelId:model.modelId}});
 if(path.endsWith('/ai/options'))return json({profile:'core',multiAgentMode:'off',contextWindow:64000,maxOutput:8192,silentReadFiles:true,silentWriteFiles:false,silentReadSQL:true,silentCommands:true});
 if(path==='/api/ai/presets'||path.endsWith('/ai/references')||path.endsWith('/terminals/available'))return json([]);
 if(path.endsWith('/message-queue'))return json({paused:false,revision:0,lastError:'',items:[]});
 if(path==='/api/settings/skills')return json({skills:[],roots:[]});
 if(path==='/api/settings/mcp')return json({servers:[]});
 return json({error:'README 演示没有此接口'},404);
};
class ReadmeEvents extends EventTarget{
 static CONNECTING=0;static OPEN=1;static CLOSED=2;readyState=1;
 onopen:((event:Event)=>void)|null=null;onerror:((event:Event)=>void)|null=null;onmessage:((event:MessageEvent<string>)=>void)|null=null;
 constructor(..._args:unknown[]){super();queueMicrotask(()=>this.onopen?.(new Event('open')));}
 close(){this.readyState=2;}
}
window.EventSource=ReadmeEvents as unknown as typeof EventSource;
createRoot(document.getElementById('root')!).render(<App/>);
