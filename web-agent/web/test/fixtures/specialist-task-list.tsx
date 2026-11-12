// The real App with fictional in-memory API data; never calls a model or host.
import './readme-workbench';
import type {Resource,ResourceTreeNode,SessionSnapshot,SpecialistChannelInfo,SpecialistChannelPage,SuperWorker,WorkSession} from '../../../shared/contracts';
import {isLakeAvatarName} from '../../../shared/specialist-avatars';
const base=window.fetch.bind(window),query=new URLSearchParams(location.search),projectId='demo-project',at='2026-11-11T01:20:00Z';
const roleId='fixture-ops-33';
const channel:SpecialistChannelInfo={id:'fixture-channel',sessionId:'demo-session-1',projectId,roleId,roleName:'服务器运维排查专员',duties:query.has('plain')?undefined:'负责服务器、集群巡检与故障排查',revision:1,roleRevision:1,createdAt:at,execution:{kind:'acp',agent:'codex',revision:2},messageRead:{cursor:'00000000000000000001',seenCursor:''}};
const resources:Resource[]=['k8s-master','app-server','server-01'].map(id=>({id,projectId,name:id,kind:'ssh',status:'available',description:'虚构展示资源'}));
const tree:ResourceTreeNode[]=[{id:'zmy',projectId,parentId:null,kind:'folder',name:'zmy',resourceId:null,position:0},{id:'cluster',projectId,parentId:'zmy',kind:'folder',name:'韦二',resourceId:null,position:0},{id:'company',projectId,parentId:'zmy',kind:'folder',name:'南京公司',resourceId:null,position:1},...resources.map((r,i)=>({id:`node-${r.id}`,projectId,parentId:i===2?'company':'cluster',kind:'resource' as const,name:r.name,resourceId:r.id,position:i}))];
const titles=['检查韦二 Kubernetes 集群状态','检查服务器资源状态','核实集群节点告警','检查主机运行状态','汇总服务器巡检报告','检查磁盘空间与日志','检查主机运行状态','检查数据库连接'];
const states:SuperWorker['task']['state'][]=['running','running','waiting_user','completed','completed','cancelled','completed','failed'];
const workers:SuperWorker[]=query.has('empty')?[]:titles.map((title,i)=>({id:`fixture-worker-${i}`,sessionId:`fixture-session-${i}`,roleId,roleName:channel.roleName,createdAt:new Date(Date.parse(at)-i*600_000).toISOString(),assignmentState:i<2?'active':i===2?'waiting_user':'parked',...(i<2?{activity:{phase:'tool' as const,label:i===0?'正在核对节点就绪状态与工作负载异常。':'正在读取主机资源指标。',updatedAt:at}}:{}),task:{taskId:`fixture-task-${i}`,sessionId:`fixture-session-${i}`,projectId,title,state:states[i],acceptanceState:states[i]==='completed'?'pass':'not_evaluated',revision:1,originRootTurnId:`fixture-root-${i}`,deadlineAt:'2027-01-01T00:00:00Z',updatedAt:at,resources:[{runtime:'ssh',assetRef:resources[i%resources.length].id}],summary:i>2?'展示数据：已读取系统指标，未执行真实检查。':undefined},execution:{backend:i===6?{kind:'native'}:{kind:'acp',agent:'codex',revision:2},assignedAt:at,source:'task_assignment',totalRuns:i===6?0:1,runs:i===6?[]:[{id:`fixture-run-${i}`,agent:'codex',scope:'worker',state:i<3?'running':'completed',dispatchPhase:i<3?'sent':'answered',createdAt:at,updatedAt:at,usage:null}]}}));
if(query.has('history')&&!query.has('empty')){
 const original=[...workers],labels=['查询应用系统的部署位置','检查业务集群当前状态','排查服务器异常重启','检查云服务器运行状态','对比主节点磁盘使用情况','核实备份与存储状态','复查服务健康检查','整理本轮巡检结果'];
 workers.splice(0,workers.length,...Array.from({length:34},(_,i)=>{
  const source=original[i%original.length],state:SuperWorker['task']['state']=i<4?'blocked':i<8?'paused':i<12?'cancelled':'completed';
  return {...source,id:`fixture-worker-${i}`,sessionId:`fixture-session-${i}`,activity:undefined,assignmentState:'parked',createdAt:new Date(Date.parse(at)-i*600_000).toISOString(),
   task:{...source.task,taskId:`fixture-task-${i}`,sessionId:`fixture-session-${i}`,title:labels[i%labels.length]+(i>=8?` · 第 ${Math.floor(i/8)+1} 轮`:''),state,acceptanceState:state==='completed'?'pass':'not_evaluated',resources:[]},
   execution:{...source.execution!,backend:i<2?{kind:'acp',agent:'codex',revision:2}:{kind:'native'},runs:[],totalRuns:0}};
 }));
}
if(query.has('plain'))for(const worker of workers)if(!worker.activity)worker.task.resources=[];
let revision=1,offline=false,reading=true;
window.lakeWindowAttention={isReading:async()=>reading};
let readFailure=false,readGate:Promise<void>|undefined,releaseRead:(()=>void)|undefined;
const writes:{path:string;body:unknown}[]=[],requests:string[]=[];
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const snapshots=new Map(workers.map((worker,i)=>{
 const todos=['读取资源目录','连接集群入口','检查节点与工作负载','汇总检查结果'].map((content,n)=>({content,status:i>2?'completed':n<(i===0?2:1)?'completed':n===(i===0?2:1)?'in_progress':'pending'}));
 const goal={id:worker.task.taskId,sessionId:worker.sessionId,originRootTurnId:worker.task.originRootTurnId,title:worker.task.title,status:worker.task.state,revision:1,items:query.has('history')?[]:todos.map((todo,n)=>({id:`step-${n}`,title:todo.content,status:todo.status==='in_progress'?'running':todo.status})),modelRounds:0,deadlineAt:worker.task.deadlineAt,updatedAt:at};
 const snapshot={session:{id:worker.sessionId,projectId,title:worker.task.title,workspaceRole:'worker',status:i<2?'investigating':i===2?'waiting_approval':'completed'},resources,resourceTree:tree,messages:[],actions:[],terminals:[],specialists:[],evidence:[],cursor:revision,superagent:{task:worker.task,roleId:worker.roleId,goal,execution:worker.execution},sre:{enabled:false,tasks:[]},messageQueue:{paused:false,revision:0,lastError:'',items:[]},ai:{session:worker.sessionId,profile:'core',status:i<2?'running':i===2?'waiting_approval':'completed',cards:[{id:`todo-${i}`,type:'operation',title:'TodoWrite',status:'completed',at,content:JSON.stringify({todos}),data:{taskId:worker.task.taskId}},{id:`read-${i}`,type:'operation',title:'list_assets',status:'completed',at,content:'展示数据：已定位准确资源目录。',data:{taskId:worker.task.taskId,resource_id:resources[i%3].id}}],cardsOffset:0,totalCards:2,agentRuns:[],usage:{known:false},...(i===2?{question:{id:'fixture-question',questions:[{id:'scope',title:'确认本次检查范围',reason:'展示数据，不操作真实服务器。',options:[{label:'只读检查当前集群'},{label:'补充范围说明'}]}]}}:{})}} as unknown as SessionSnapshot;
 if(query.has('history')){snapshot.ai!.status='completed';snapshot.ai!.cards=[];delete snapshot.ai!.question;}
 return [worker.sessionId,snapshot];
}));
const channelSnapshot={session:{id:channel.sessionId,projectId,title:channel.roleName,workspaceRole:'role',status:'completed'},messages:[],resources,resourceTree:tree,actions:[],terminals:[],specialists:[],evidence:[],cursor:revision,messageQueue:{paused:false,revision:0,lastError:'',items:[]},sre:{enabled:false,tasks:[]},ai:{session:channel.sessionId,profile:'core',status:'idle',cards:[],cardsOffset:0,totalCards:0,agentRuns:[],usage:{known:false}}} as unknown as SessionSnapshot;
const channels=[channel,...['发布专员','数据库专员','知识库专员','ACP 测试专员'].map((roleName,i)=>({...channel,messageRead:{...channel.messageRead!},id:`other-channel-${i}`,sessionId:`other-session-${i}`,roleId:`other-role-${i}`,roleName,duties:'查看任务进展、执行过程与结果'}))];
// Real App QA: current defaults may change, while each report keeps its Agent.
if(query.has('agent-logos'))channels.forEach((item,index)=>{item.execution=index%2?{kind:'native'}:{kind:'acp',agent:'codex'};});
const agentLogoMessages=[{id:'logo-human',sessionId:'demo-session-0',role:'user',text:'请各位专员汇报本轮进展。',createdAt:at},...channels.slice(0,3).map((member,index)=>({
    id:`logo-report-${index}`,sessionId:'demo-session-0',role:'assistant',text:['已核对当前任务，保留原执行记录。','已整理发布记录，等待你的后续安排。','增量迁移方案已准备，尚未执行。'][index],createdAt:new Date(Date.parse(at)+(index+1)*1000).toISOString(),
    author:{kind:'specialist',name:member.roleName,roleId:member.roleId,workerId:index===0?workers[0]?.id:`logo-worker-${index}`,sessionId:index===0?workers[0]?.sessionId:`logo-session-${index}`,taskId:index===0?workers[0]?.task.taskId:`logo-task-${index}`,channelSessionId:member.sessionId,execution:structuredClone(member.execution)},
   }))];
Object.assign(window,{lakeAgentLogoQA:{native(){channel.execution={kind:'native'};revision++;}}});
function collaborate(worker:SuperWorker,count:number){
 if(count<2){delete worker.task.collaboration;return;}
 worker.task.collaboration={state:'running',acceptanceState:'not_evaluated',participants:channels.slice(0,count).map((member,i)=>({workerId:i===0?worker.id:`${worker.id}-member-${i}`,sessionId:i===0?worker.sessionId:`${worker.sessionId}-member-${i}`,roleId:member.roleId,roleName:member.roleName,state:i===0?worker.task.state:i===1?'running':i===2?'completed':'waiting_user',contributed:i===2}))};
}
if(query.has('collaboration')){
 channels.push({...channel,id:'sixth-channel',sessionId:'sixth-session',roleId:'other-role-4',roleName:'负责跨区域业务服务稳定性的协作专员'});
 const avatars=['heron','kingfisher','otter','beaver','turtle','dragonfly'] as const;
 channels.forEach((item,i)=>{item.avatarId=avatars[i];});
 workers.slice(0,3).forEach((worker,i)=>collaborate(worker,[2,3,6][i]));
}
Object.assign(window,{lakeReadQA:{
 state(session=channel.sessionId){return {...channels.find(item=>item.sessionId===session)?.messageRead};},
 attention(value:boolean){reading=value;},
 fail(value:boolean){readFailure=value;},
 hold(){readGate=new Promise<void>(resolve=>{releaseRead=resolve;});},
 release(){releaseRead?.();releaseRead=undefined;readGate=undefined;},
 message(session=channel.sessionId){const state=channels.find(item=>item.sessionId===session)!.messageRead!;state.cursor=String(Number(state.cursor)+1).padStart(20,'0');revision++;},
 settle(){for(const worker of workers){worker.assignmentState='parked';if(worker.task.state==='running')worker.task.state='completed';const snap=snapshots.get(worker.sessionId);if(snap)snap.ai!.status='completed';}revision++;},
}});
Object.assign(window,{lakeRoleConfigQA:{
 avatar(value:string){if(value!=='auto'&&!isLakeAvatarName(value))throw Error('Unknown fixture avatar');channel.avatarId=value==='auto'?undefined:value;channel.roleRevision=(channel.roleRevision??1)+1;revision++;},
}});
Object.assign(window,{lakeTaskListQA:{writes,requests,offline(value:boolean){offline=value;},pulse(){revision++;},collaborate(count:number){collaborate(workers[0],count);revision++;},reverseMembers(){workers[0].task.collaboration?.participants.reverse();revision++;},many(){for(let i=0;i<35;i++){const worker={...workers[0],id:`extra-${i}`,sessionId:`extra-session-${i}`,createdAt:new Date(Date.parse(at)-i*50_000).toISOString(),task:{...workers[0].task,taskId:`extra-task-${i}`,title:`演示历史任务 ${i+1}`}};workers.push(worker);}},finish(){workers[0].task={...workers[0].task,state:'completed',acceptanceState:'pass'};workers[0].assignmentState='parked';revision++;}}});
window.fetch=async(input,init)=>{
 const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href),path=url.pathname;
 if(!path.startsWith('/api/'))return base(input,init);
 requests.push(path);
 if(offline&&path.endsWith('/channel'))return json({error:'演示连接暂时断开'},503);
 if(init?.method&&init.method!=='GET'){
  const body=init.body?JSON.parse(String(init.body)):{};writes.push({path,body});
  if(path.endsWith('/messages-read')){
   const current=channels.find(item=>item.sessionId===path.split('/')[3]),state=current?.messageRead;
   if(readFailure)return json({error:'模拟已读保存失败，请重试'},503);
   if(!state||!/^\d{20}$/.test(body.cursor)||body.cursor>state.cursor)return json({error:'无效读取位置'},409);
   if(readGate)await readGate;
   state.seenCursor=state.seenCursor>body.cursor?state.seenCursor:body.cursor;return json({cursor:state.seenCursor});
  }
  if(path.endsWith('/questionReply')){const snap=snapshots.get(path.split('/')[3]);if(snap)delete snap.ai!.question;}
  if(path.endsWith('/workControl')){const worker=workers.find(item=>path.includes('/'+item.sessionId+'/'));if(worker){worker.task.state='cancelled';worker.assignmentState='parked';}}
  return json({});
 }
 if(path.endsWith('/superagent'))return json({active:true,project:{projectId,routerSessionId:'demo-session-0',version:1},channels,workers,cursor:revision});
 if(path.endsWith('/external-agents'))return json({agents:[{id:'codex',name:'Codex',projectId,revision:2,enabled:true,installed:true,transportReady:true,assignmentReady:true,model:'本机 Codex 配置',authMode:'chatgpt',updatedAt:at}]});
 if(path.endsWith('/channel')){
  const current=channels.find(item=>path.includes('/'+item.sessionId+'/'))??channel,own=current===channel?workers:[];
  const page:SpecialistChannelPage={channel:current,workers:own,entries:own.flatMap(worker=>{const snap=snapshots.get(worker.sessionId);return snap?snap.ai!.cards.map(card=>({id:card.id,sourceSessionId:worker.sessionId,taskId:worker.task.taskId,createdAt:at,card})):[];}),active:own.filter(worker=>['running','waiting_user'].includes(worker.task.state)).flatMap(worker=>{const snapshot=snapshots.get(worker.sessionId);return snapshot?[snapshot]:[];}),routing:false,queued:0,nextCursor:'',replyPresentation:'invocation'};
  const reported=own.find(worker=>worker.id==='fixture-worker-3');
  if(reported)page.entries.push({id:'fixture-delivered-report',sourceSessionId:reported.sessionId,taskId:reported.task.taskId,createdAt:at,message:{id:'fixture-report-message',sessionId:current.sessionId,role:'assistant',text:reported.task.summary!,createdAt:at}});
  return json(page);
 }
 if(path.endsWith('/snapshot')){
  const id=path.split('/')[3],own=snapshots.get(id);if(own)return json({...own,cursor:revision});
  if(channels.some(item=>item.sessionId===id)){const ch=channels.find(item=>item.sessionId===id)!;return json({...channelSnapshot,session:{...channelSnapshot.session,id,title:ch.roleName},cursor:revision});}
  if(query.has('agent-logos')&&id==='demo-session-0'){
   const source=await(await base(input,init)).json(),pilot='demo-session-0';
   return json({...source,session:{...source.session,id:pilot,title:'Pilot',workspaceRole:'router'},messages:agentLogoMessages,resources,resourceTree:tree,cursor:revision,sre:{enabled:false,tasks:[]},ai:{...source.ai,status:'completed',cards:[],cardsOffset:0,totalCards:0}});
  }
 }
 const response=await base(input,init);
 if(path==='/api/bootstrap'){const info=await response.json();return json({...info,backendRuntime:'typescript',aiRuntime:'typescript'});}
 if(path==='/api/catalog'){
  const value=await response.json();value.projects[0].name='默认工作区';value.resources=resources;value.resourceTree=tree;
  value.sessions=[{...value.sessions[0],id:'demo-session-0',title:'Pilot',workspaceRole:'router'},...channels.map(ch=>({...value.sessions[0],id:ch.sessionId,title:ch.roleName,workspaceRole:'role'}))] as WorkSession[];
  return json(value);
 }
 return response;
};
