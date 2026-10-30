// Real components and synthetic records. All fetches stay inside this fixture;
// no backend, model, SSH connection or resource operation can be reached.
import React,{useEffect,useState,useRef} from 'react';
import {createRoot} from 'react-dom/client';
import type {AIQuestionRequest,PilotSettings,SessionSnapshot,SREPlanStep,SRETask} from '../../../shared/contracts';
import {SRERoleMessage} from '../../src/SRERoleMessage';
import {LakePilotControl} from '../../src/LakePilotControl';
import {FollowScroll,observeConversationGrowth,atConversationTail} from '../../src/followScroll';
import {PilotChoiceQuestion} from '../../src/PilotChoiceQuestion';
import '../../src/theme.css';
import '../../src/styles.css';
import '../../src/sreCollaboration.css';
import '../../src/conversationDirectory.css';
import '../../src/statusText.css';
import '../../src/pilot.css';

const query=new URLSearchParams(location.search);
document.documentElement.dataset.theme=query.get('theme')==='dark'?'dark':'light';
let server:PilotSettings={enabled:false,autoAdvance:false,revision:0};
let requests=0,decisions=0;
let lastSelection:unknown=null;
window.fetch=async(input,init)=>{
 const path=String(input);requests++;
 if(path==='/api/projects/fixture/pilot'&&init?.method==='PUT'){
  const data=JSON.parse(String(init.body));
  if(data.expectedRevision!==server.revision)return new Response(JSON.stringify({error:'设置已更新'}),{status:409});
  server={enabled:data.enabled??server.enabled,autoAdvance:data.autoAdvance??server.autoAdvance,revision:server.revision+1};
  return new Response(JSON.stringify(server),{headers:{'Content-Type':'application/json'}});
 }
 if(path==='/api/sessions/fixture/ai/agentQuestionReply'&&init?.method==='POST'){
  const data=JSON.parse(String(init.body));lastSelection=JSON.parse((Object.values(data.answers)[0] as string[])[0]!);
  decisions++;return new Response('{}',{headers:{'Content-Type':'application/json'}});
 }
 return new Response(JSON.stringify({error:'隔离验收禁止访问后端'}),{status:403});
};

const at='2026-10-25T05:00:00Z';
const definitions=[
 {id:'scope',assignmentId:'coordinate',role:'coordinator',kind:'analyze',description:'明确调查范围'},
 {id:'phenomenon',assignmentId:'investigate',role:'investigator',kind:'observe',description:'确认故障现象'},
 {id:'logs',assignmentId:'investigate',role:'investigator',kind:'observe',description:'收集日志证据'},
 {id:'ports',assignmentId:'investigate',role:'investigator',kind:'observe',description:'核对端口配置'},
 {id:'change',assignmentId:'execute',role:'executor',kind:'act',description:'修正上游端口'},
 {id:'verify',assignmentId:'verify',role:'verifier',kind:'verify',description:'独立复测接口'},
 {id:'summary',assignmentId:'coordinate',role:'coordinator',kind:'summarize',description:'交付最终结论'},
];
const steps=definitions.map((step,index)=>({...step,capability:step.role==='investigator'?'application':undefined,resourceIds:['fixture-host'],dependsOn:index?[definitions[index-1]!.id]:[],completionChecks:['核对真实结果后完成']})) as SREPlanStep[];
const bodies:Record<string,string>={scope:'本次检查订单服务与代理配置，按调查、执行、独立验证推进。',phenomenon:'已复现网关返回 502。',logs:'启动日志未发现应用退出。',ports:'应用监听 8080，代理指向 8081，已核对配置差异。',change:'已按批准方案修正端口，原配置和实际执行结果均已保留。',verify:'独立检查接口与上游连接通过；本次恢复验收已完成。',summary:'服务恢复已验证；完整证据和操作记录可在对应步骤回看。'};
const task={id:'fixture-task',sessionId:'fixture',projectId:'fixture',status:'completed',goal:'核对订单服务',scope:['fixture-host'],revision:1,recoveryStatus:'verified',rootCauseStatus:'confirmed',plans:[{id:'plan',steps}],runs:[{id:'run',planRevisionId:'plan',status:'completed'}],attempts:steps.map(step=>({id:step.id,stepId:step.id,planRunId:'run',roleRunId:step.id,status:'succeeded',evidence:[],operations:[],startedAt:at,finishedAt:at})),messages:steps.map((step,index)=>({id:'message-'+step.id,sessionId:'fixture',taskId:'fixture-task',roleId:step.role,roleRunId:step.id,attemptId:step.id,kind:step.kind==='summarize'?'summary':'finding',body:bodies[step.id],revision:1,sequence:index+1,createdAt:new Date(Date.parse(at)+index*60000).toISOString()})),verifications:[]} as SRETask;
const choice:AIQuestionRequest={id:'fixture-choice',questions:[{id:'pilot',title:'选择处理方向'}],pilot:{sessionId:'fixture',taskId:'fixture-task',planRevisionId:'plan',stepId:'logs',attemptId:'logs',role:'investigator',directions:[{id:'logs',title:'检查应用运行状态',reason:'确认应用进程与监听端口。',recommended:true,operations:[{id:'status',title:'查看服务状态',tool:'shell',arguments:{command:'systemctl status order-service --no-pager'},risk:'readonly'},{id:'ports',title:'检查监听端口',tool:'shell',arguments:{command:'ss -lntp'},risk:'readonly'},{id:'logs',title:'查看启动日志',tool:'shell',arguments:{command:'journalctl -u order-service -n 100 --no-pager'},risk:'readonly'}]},{id:'config',title:'核对代理配置',reason:'检查上游目标是否匹配。',operations:[{id:'read',title:'读取代理配置',tool:'read',arguments:{path:'/etc/nginx/conf.d/order.conf'},risk:'readonly'}]}]}};

const hostDescription='在演示主机上只读取系统基础指标：date、uptime、load average（1/5/15 分钟）、free -m 完整输出、根分区 df -h /，以及 swap 启用情况。不得执行任何写操作、重启或配置变更。';
const hostTask={...task,status:'waiting_input',plans:[{...task.plans[0]!,steps:[{...steps[2]!,description:hostDescription}]}],runs:[{...task.runs[0]!,status:'running'}],attempts:[{...task.attempts[2]!,status:'running'}],messages:[{...task.messages[2]!,kind:'progress',body:hostDescription}]} as SRETask;
const hostChoice:AIQuestionRequest={...choice,pilot:{...choice.pilot!,directions:[{id:'overview',title:'只读主机概览快照',reason:'读取负载、内存、磁盘与 swap 概览。',recommended:true,operations:[{id:'overview',title:'读取主机概览指标',tool:'observe_host',arguments:{asset_ref:'a_fixture_host',metric:'overview'},risk:'readonly'}]}]}};


function ScrollFixture(){
 const box=useRef<HTMLDivElement>(null),follower=useRef<FollowScroll|null>(null),following=useRef(true);
 const [pulse,setPulse]=useState(0),[rows,setRows]=useState(0);
 useEffect(()=>{const timer=setInterval(()=>setPulse(value=>value>=30?value:value+1),80);return()=>clearInterval(timer)},[]);
 useEffect(()=>{
  const container=box.current!;
  const stats={requests:0,writes:0,get animating(){return follower.current?.animating??false}};
  const descriptor=Object.getOwnPropertyDescriptor(Element.prototype,'scrollTop')!;
  Object.defineProperty(container,'scrollTop',{configurable:true,get(){return descriptor.get!.call(container)},set(value){stats.writes++;descriptor.set!.call(container,value)}});
  const scroll=new FollowScroll(container,()=>following.current);follower.current=scroll;scroll.jump();
  (window as unknown as {pilotScrollQA:typeof stats}).pilotScrollQA=stats;
  stats.writes=0;
  const stop=observeConversationGrowth(container,()=>{stats.requests++;scroll.request()});
  return()=>{stop();scroll.stop();delete (container as unknown as {scrollTop?:number}).scrollTop};
 },[]);
 const current={...hostTask,status:'active',pilot:{autoAdvance:true,settingsRevision:1}} as SRETask;
 const snapshot={session:{id:'fixture',projectId:'fixture'},resources:[],sre:{enabled:true,pilot:server,tasks:[current]},ai:{status:'running',agentRuns:[{id:'logs',sreTaskId:current.id,status:'running',createdAt:at,startedAt:at,activityUpdatedAt:new Date(Date.parse(at)+pulse*1000).toISOString(),activityPhase:pulse%2?'tool':'thinking',activityTool:'grep',toolCount:pulse,evidence:Array.from({length:pulse},(_,i)=>({id:String(i)}))}]}} as SessionSnapshot;
 return <main style={{maxWidth:query.get('width')==='390'?390:900,margin:'24px auto',padding:24}}>
  <p>仅验证滚动，不连接资源</p><button onClick={()=>setRows(value=>value+1)}>新增内容行</button><button onClick={()=>setRows(0)}>收起新增行</button>
  <div ref={box} tabIndex={0} className="fixture-scroll" style={{height:280,overflow:'auto',overflowAnchor:'none',marginTop:16}} onWheel={()=>{following.current=false;follower.current?.stop()}} onKeyDown={event=>{if(event.key==='PageUp'){following.current=false;follower.current?.stop()}}} onScroll={()=>{if(!follower.current?.animating)following.current=atConversationTail(box.current!)}}><div>
   <div style={{height:450}}>历史记录占位</div>
   <SRERoleMessage task={current} entry={current.messages[0]!} snapshot={snapshot} renderApproval={()=>null} onUpdated={()=>{}}/>
   {Array.from({length:rows},(_,i)=><p className="fixture-new-row" key={i}>新增的实际内容行 {i+1}</p>)}
  </div></div><output>{JSON.stringify({pulse,rows,requests})}</output>
 </main>;
}

function Fixture(){
 const [settings,setSettings]=useState(server),[,render]=useState(0);
 const [pulse,setPulse]=useState(0);useEffect(()=>{if(query.get('view')!=='live')return;const timer=setInterval(()=>setPulse(value=>value>=30?value:value+1),80);return()=>clearInterval(timer)},[]);
 const snapshot={session:{id:'fixture',projectId:'fixture'},ai:{profile:'core',status:'completed',agentRuns:[]},resources:[{id:'fixture-host',name:'隔离测试主机'}],sre:{enabled:settings.enabled,pilot:settings,tasks:[task]}} as SessionSnapshot;
 const refresh=async()=>{setSettings({...server});render(value=>value+1)};
 const hostSnapshot={...snapshot,ai:{...snapshot.ai,agentRuns:[{id:'logs',sreTaskId:hostTask.id,status:'waiting_input',question:hostChoice}]},sre:{...snapshot.sre,tasks:[hostTask]}} as SessionSnapshot;
 const liveTask={...hostTask,status:'active',pilot:{autoAdvance:true,settingsRevision:1},messages:[{...hostTask.messages[0]!,...(pulse?{body:`内部过程 ${pulse}`,source:'model'}:{})}]} as SRETask;
 const liveSnapshot={...hostSnapshot,sre:{...hostSnapshot.sre,tasks:[liveTask]},ai:{...hostSnapshot.ai,agentRuns:[{id:'logs',sreTaskId:liveTask.id,status:'running',liveTextId:`part-${pulse}`,liveText:pulse?`内部过程 ${pulse}`:'',activityPhase:'tool',activityTool:pulse%2?'grep':'read',toolCount:pulse,createdAt:at,startedAt:at}]}} as SessionSnapshot;
 return <main style={{maxWidth:query.get('width')==='390'?390:900,margin:'28px auto',padding:'0 24px'}}>
  <p style={{color:'var(--text-muted)',fontSize:'var(--font-size-toolbar)'}}>Lake Pilot · 隔离测试数据，不连接实际资源</p>
  <div className="composer-foot" style={{margin:'16px 0 28px'}}><span>权限</span><LakePilotControl snapshot={snapshot} onUpdated={refresh}/></div>
  {query.get('view')==='live'?<SRERoleMessage task={liveTask} entry={liveTask.messages[0]!} snapshot={liveSnapshot} renderApproval={()=>null} onUpdated={()=>{}}/>:query.get('view')==='host'?<SRERoleMessage task={hostTask} entry={hostTask.messages[0]!} snapshot={hostSnapshot} renderApproval={()=><PilotChoiceQuestion request={hostChoice} session="fixture" runId="logs" refresh={refresh}/>} onUpdated={()=>{}}/>:query.get('view')==='choice'?<PilotChoiceQuestion request={choice} session="fixture" runId="logs" refresh={refresh}/>:task.messages.filter(message=>['scope','phenomenon','change','verify'].includes(message.attemptId??'')).map(entry=><SRERoleMessage key={entry.id} task={task} entry={entry} snapshot={snapshot} renderApproval={()=>null} onUpdated={()=>{}}/>)}
  <output aria-label="隔离请求统计" style={{color:'var(--text-muted)',fontSize:'var(--font-size-toolbar)',overflowWrap:'anywhere'}}>{JSON.stringify({pulse,requests,decisions,lastSelection,...settings})}</output>
 </main>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode>{query.get('view')==='scroll'?<ScrollFixture/>:<Fixture/>}</React.StrictMode>);
