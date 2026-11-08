import {useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import type {AICard,Message,SessionSnapshot,SpecialistReplyAuthor,SuperWorker,SuperWorkerActivity,SuperWorkspace,WorkSession} from '../../../shared/contracts';
import {AITranscript} from '../../src/AIPanel';
import {SessionInspectorProvider,useSessionInspector,sessionInspectorId} from '../../src/SessionInspectorContext';
import {SessionStateBadge} from '../../src/SessionPresentation';
import {SuperRoleAvatar} from '../../src/SuperRoleAvatar';
import {superPilotActivity} from '../../src/superPilotActivity';
import {initializeFocusModality} from '../../src/focusModality';
import '../../src/sessionPresentation.css';
import '../../src/conversationDirectory.css';
import '../../src/styles.css';
import '../../src/pilotWorkspace.css';
import '../../src/sreCollaboration.css';
import '../../src/assistantProse.css';
import '../../src/conversationBubbles.css';

initializeFocusModality();
document.documentElement.dataset.theme=new URLSearchParams(location.search).get('theme')==='dark'?'dark':'light';
const stages=['排队','思考中','检查主机','等待确认','等待回答','等待外部结果','两位专员','部分完成','全部完成','已暂停','断线','同一专员两项任务','追加独立问题','原任务重试','长名称','历史状态无活动','原问题已裁剪','派单前言','派单失败','派单恢复','派单恢复后回复','实际检查失败','实际操作待确认'];
const at='2026-11-06T00:00:00Z';
const router={id:'pilot-preview',projectId:'project-preview',title:'Pilot',status:'completed',workspaceRole:'router',createdAt:at,updatedAt:at,options:{}} as WorkSession;
const phases:SuperWorkerActivity['phase'][]=['queued','thinking','tool','waiting_approval','waiting_input','waiting_external'];
const labels={queued:'准备处理',thinking:'正在分析',tool:'正在检查主机',waiting_approval:'等待你确认',waiting_input:'等待你补充信息',waiting_external:'等待外部结果'};
const continuity={firstReplacements:0,replyReplacements:0};
Object.assign(window,{lakePilotDispatchQA:continuity});
function makeWorker(id:string,name:string,phase:SuperWorkerActivity['phase']='tool'):SuperWorker{
 return {id,roleId:`role-${id}`,roleName:name,sessionId:`worker-${id}`,assignmentState:phase==='queued'?'queued':'active',
  task:{taskId:`task-${id}`,sessionId:`worker-${id}`,projectId:router.projectId,title:id==='host'?'分析服务器整体情况':'核对两端数据库记录数量',state:phase==='queued'?'queued':phase==='waiting_external'?'waiting_external':phase.startsWith('waiting')?'waiting_user':'running',acceptanceState:'not_evaluated',revision:1,originRootTurnId:`root-${id}`,deadlineAt:at},
  activity:{phase,label:labels[phase],updatedAt:at,sourceSessionId:router.id,sourceMessageId:'user'}};
}
function FixtureExecutionHost(){
 const inspector=useSessionInspector()!;
 return <aside hidden={!inspector.selection} aria-label="样例执行详情" style={{marginTop:20,padding:16,border:'1px solid var(--border)'}}>
  <button type="button" onClick={inspector.close}>关闭执行详情</button>
  <div id={sessionInspectorId} ref={inspector.setHost}/>
 </aside>;
}
function Fixture(){
 const [stage,setStage]=useState(1),[selected,setSelected]=useState('');
 useEffect(()=>{
  const previous=new Map<string,Element>();
  const check=()=>{for(const [id,key] of [['dispatch-preface','firstReplacements'],['dispatch-answer','replyReplacements']] as const){
   const node=document.querySelector(`[data-conversation-entry="${id}"]`);
   if(node){if(previous.has(id)&&previous.get(id)!==node)continuity[key]++;previous.set(id,node);}
  }};
  const observer=new MutationObserver(check);observer.observe(document.getElementById('root')!,{subtree:true,childList:true});return()=>observer.disconnect();
 },[]);
 const host=makeWorker('host','服务器运维排查专员',phases[stage]??'tool'),database=makeWorker('database','数据库专员');
 const workers=[host];
 if([6,7,8,11].includes(stage))workers.push(database);
 if(stage===11){database.roleId=host.roleId;database.roleName=host.roleName;database.task.title='检查另一台服务器的磁盘余量';}
 if(stage===14){host.roleName='服务器运行状态及网络连接排查专员';host.task.title='检查长名称生产服务器在高峰时段的 CPU、内存、磁盘和关键服务运行情况';}
 const author=(worker:SuperWorker):SpecialistReplyAuthor=>({kind:'specialist',name:worker.roleName,roleId:worker.roleId,workerId:worker.id,sessionId:worker.sessionId,taskId:worker.task.taskId,channelSessionId:`channel-${worker.roleId}`});
 const messages:Message[]=[{id:'user',sessionId:router.id,role:'user',text:'分析一下服务器的整体情况。',createdAt:at},
  {id:'pilot-reply',sessionId:router.id,role:'assistant',text:'我让服务器运维排查专员检查一下这台服务器。',createdAt:'2026-11-06T00:00:01Z'}];
 if(stage===7||stage===8){host.activity=undefined;host.assignmentState='parked';host.task.state='completed';host.task.acceptanceState='pass';messages.push({id:'host-report',sessionId:router.id,role:'assistant',author:author(host),text:'已读取当前系统指标：CPU 和内存使用正常，磁盘空间充足。',createdAt:'2026-11-06T00:00:03Z'});}
 if(stage===8){database.activity=undefined;database.assignmentState='parked';database.task.state='completed';database.task.acceptanceState='pass';messages.push({id:'database-report',sessionId:router.id,role:'assistant',author:author(database),text:'两端数据库的记录数量一致。',createdAt:'2026-11-06T00:00:04Z'});}
 if(stage===9){host.activity=undefined;host.assignmentState='parked';host.task.state='paused';messages.push({id:'paused-report',sessionId:router.id,role:'assistant',author:author(host),text:'连接已中断，这次还没有取得实时指标。',createdAt:'2026-11-06T00:00:04Z'});}
 if(stage===15)host.activity=undefined;
 if(stage===16){messages.shift();messages.push({id:'new-question',sessionId:router.id,role:'user',text:'另外介绍一下你自己。',createdAt:'2026-11-06T00:00:05Z'},{id:'new-answer',sessionId:router.id,role:'assistant',text:'我是 Lake Pilot。',createdAt:'2026-11-06T00:00:06Z'});}
 if(stage===12||stage===13){messages.push({id:'followup',sessionId:router.id,role:'user',text:stage===12?'另外介绍一下你自己。':'再试试',createdAt:'2026-11-06T00:00:05Z'},
  {id:'new-reply',sessionId:router.id,role:'assistant',text:stage===12?'我是 Lake Pilot，可以帮你分析问题和安排检查。':'我再检查一下这台服务器。',createdAt:'2026-11-06T00:00:06Z'});if(stage===13)host.activity!.sourceMessageId='followup';}
 const cards:AICard[]=[];
 if(stage>=17){
  messages.splice(1);
  cards.push({id:'dispatch-preface',at:'2026-11-06T00:00:01Z',type:'message',status:'completed',content:'我让运维专员检查一下服务器。'});
  const args={event_id:'fixture-event',part_key:'inspect-host',action:'create'};
  if(stage>=18)cards.push({id:'dispatch-failure',at:'2026-11-06T00:00:02Z',type:'operation',title:'route_work',status:'failed',data:{arguments:args},content:'Synthetic original dispatch validation failure'});
  if(stage>=19)cards.push({id:'dispatch-success',at:'2026-11-06T00:00:03Z',type:'operation',title:'route_work',status:'completed',data:{arguments:args},content:JSON.stringify({eventId:args.event_id,partKey:args.part_key,action:args.action,workerId:host.id,taskId:host.task.taskId,dispatch:{state:'queued',unresolvedOperations:0}})});
  if(stage===21||stage===22)cards.push({id:'host-operation',at:'2026-11-06T00:00:04Z',type:'operation',title:'inspect_host',status:stage===21?'failed':'pending',data:{arguments:{asset_ref:'fixture-host'}},content:stage===21?'Synthetic SSH connection timeout':'Awaiting explicit host-read approval'});
  if(stage>=20)cards.push({id:'dispatch-answer',at:'2026-11-06T00:00:05Z',type:'message',status:'completed',content:stage===21?'这次连接超时，还没有取得服务器指标。':stage===22?'需要你确认后，才能读取这台服务器的指标。':'已安排检查，进展会显示在这里。'});
  if(stage<=18)workers.splice(0);
  if(stage===19){host.activity!.phase='queued';host.activity!.label='等待开始';host.assignmentState='queued';host.task.state='queued';}
  if(stage===21){host.activity=undefined;host.assignmentState='parked';host.task.state='paused';}
  if(stage===22){host.activity!.phase='waiting_approval';host.activity!.label='等待操作确认';host.task.state='waiting_user';}
 }
 const workspace:SuperWorkspace={active:true,project:{projectId:router.projectId,routerSessionId:router.id,version:1},workers,channels:workers.map(worker=>({id:`channel-${worker.roleId}`,roleId:worker.roleId,roleName:worker.roleName,sessionId:`channel-${worker.roleId}`,projectId:router.projectId,revision:1,createdAt:at}))};
 const aggregate=superPilotActivity(workspace,router,stage!==10);
 const snapshot={session:router,messages,resources:[],actions:[],ai:{session:router.id,status:stage>=17&&stage<=19?'running':stage===22?'waiting_approval':'completed',turnStartedAt:at,cards,cardsOffset:0}} as SessionSnapshot;
 return <main style={{height:'100%',overflow:'auto',padding:'20px clamp(12px,4vw,40px)'}}>
  <div style={{maxWidth:900,margin:'0 auto'}}>
   <header style={{display:'flex',gap:6,flexWrap:'wrap',marginBottom:24}}>
    <button onClick={()=>{document.documentElement.dataset.theme=document.documentElement.dataset.theme==='dark'?'light':'dark';}}>切换主题</button>
    {stages.map((label,index)=><button key={label} aria-pressed={stage===index} onClick={()=>setStage(index)}>{label}</button>)}
   </header>
   <p data-preview-stage={stage}>状态预览：{stages[stage]}（隔离样例，无模型或服务器调用）</p>
   <div style={{display:'flex',alignItems:'center',gap:8,margin:'20px 0 32px'}}><SuperRoleAvatar pilot name="Pilot" size={28} motion={aggregate?.motion??'idle'}/><strong>Pilot</strong><SessionStateBadge session={router} {...(aggregate??{})}/></div>
   <AITranscript snapshot={snapshot} pilotWorkspace={workspace} assistantIdentity={{name:'Pilot',pilot:true}} pilotConnected={stage!==10} onSpecialist={value=>setSelected(`${value.channelSessionId} / ${value.taskId}`)}/>
   <FixtureExecutionHost/>
   <output aria-label="打开的专员" style={{display:'block',marginTop:28}}>{selected}</output>
  </div>
 </main>;
}
createRoot(document.getElementById('root')!).render(<SessionInspectorProvider><Fixture/></SessionInspectorProvider>);
