// Real App, fictional local API only. No model, credentials or host operations.
import './readme-workbench';
import type {SpecialistChannelInfo,SpecialistChannelPage,SuperWorker,SessionSnapshot} from '../../../shared/contracts';
const baseFetch=window.fetch.bind(window),projectId='demo-project';
const channels:SpecialistChannelInfo[]=[1,2].map(i=>({id:`channel-${i}`,projectId,roleId:`role-${i}`,roleName:i===1?'服务器运维专员':'依赖检查专员',sessionId:`demo-session-${i}`,revision:1,createdAt:'2026-11-03T08:00:00Z',needsConfirmation:i===2}));
let running=true;
const stopped:string[]=[];
const loaded=new Set<string>();
const worker=(ch:SpecialistChannelInfo):SuperWorker=>({id:`worker-${ch.id}`,roleId:ch.roleId,roleName:ch.roleName,sessionId:`worker-session-${ch.id}`,assignmentState:ch.needsConfirmation?'waiting_user':'parked',task:{taskId:`task-${ch.id}`,sessionId:`worker-session-${ch.id}`,projectId,title:ch.needsConfirmation?'核对原步骤':'历史只读检查',state:ch.needsConfirmation?'waiting_user':'completed',acceptanceState:'insufficient',revision:1,originRootTurnId:'original-root',deadlineAt:'2026-11-04T08:00:00Z'}});
const json=(value:unknown)=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
Object.assign(window,{lakeChannelUIQA:{stopped}});
window.fetch=async(input,init)=>{
 const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href),path=url.pathname;
 if(path.endsWith('/superagent'))return json({active:true,project:{projectId,routerSessionId:'demo-session-0',version:1},channels,workers:channels.map(worker)});
 if(path.endsWith('/channel')){
  const id=decodeURIComponent(path.split('/')[3]!),ch=channels.find(item=>item.sessionId===id)!;
  if(init?.method==='POST'){stopped.push(path);running=false;return json({stopped:true});}
  if(!loaded.has(id)){loaded.add(id);await new Promise(resolve=>setTimeout(resolve,700));}
  const task=worker(ch),at='2026-11-03T08:00:00Z';
  const active=ch.needsConfirmation?[{session:{id:task.sessionId,title:task.task.title,projectId,status:'waiting_approval',workspaceRole:'worker'},resources:[],resourceTree:[],messages:[],evidence:[],actions:[],terminals:[],specialists:[],cursor:1,superagent:{task:task.task},ai:{session:task.sessionId,profile:'core',usage:{known:false,input:0,output:0,total:0},status:'waiting_approval',cards:[],cardsOffset:0,totalCards:0,question:{id:'original-question',questions:[{id:'work_contract',title:'确认原步骤',reason:'虚构界面验收，不执行实际操作。',options:[{label:'确认步骤'}]}]}}} as unknown as SessionSnapshot]:[];
  const page:SpecialistChannelPage={channel:ch,workers:[task],routing:ch.sessionId==='demo-session-1'&&running,queued:0,active,nextCursor:'',entries:Array.from({length:80},(_,i)=>{const createdAt=new Date(Date.UTC(2026,10,3,7,i)).toISOString();return{id:`entry-${ch.id}-${i}`,sourceSessionId:task.sessionId,taskId:task.task.taskId,createdAt,message:{id:`message-${i}`,sessionId:task.sessionId,role:i%3===0?'user':'assistant',createdAt,text:`历史记录 ${i+1}：同一个专员入口持续沟通，任务执行记录与上下文保持独立。这里只用于验证加载过渡，不执行任何操作。`}};})};
  return json(page);
 }
 const response=await baseFetch(input,init);
 if(!response.ok||!['/api/catalog'].includes(path)&&!path.endsWith('/snapshot'))return response;
 const value=await response.json();
 if(path==='/api/catalog')for(const session of value.sessions){const ch=channels.find(item=>item.sessionId===session.id);session.workspaceRole=ch?'role':'pilot';session.title=ch?.roleName??'Pilot';session.status='completed';}
 else{
  const id=decodeURIComponent(path.split('/')[3]!),ch=channels.find(item=>item.sessionId===id);
  value.session={...value.session,id,title:ch?.roleName??'Pilot',workspaceRole:ch?'role':'pilot',status:'completed'};
  value.ai={...value.ai,session:id,status:'idle',cards:[],agentRuns:[],cardsOffset:0,totalCards:0};value.messages=[];value.replyTimings=[];value.sre={enabled:false,tasks:[]};delete value.superagent;
 }
 return json(value);
};
