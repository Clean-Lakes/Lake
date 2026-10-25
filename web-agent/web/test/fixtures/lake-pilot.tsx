// Real components and synthetic records. All fetches stay inside this fixture;
// no backend, model, SSH connection or resource operation can be reached.
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import type {AIQuestionRequest,PilotSettings,SessionSnapshot,SREPlanStep,SRETask} from '../../../shared/contracts';
import {SRERoleMessage} from '../../src/SRERoleMessage';
import {LakePilotControl} from '../../src/LakePilotControl';
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
window.fetch=async(input,init)=>{
 const path=String(input);requests++;
 if(path==='/api/projects/fixture/pilot'&&init?.method==='PUT'){
  const data=JSON.parse(String(init.body));
  if(data.expectedRevision!==server.revision)return new Response(JSON.stringify({error:'设置已更新'}),{status:409});
  server={enabled:data.enabled??server.enabled,autoAdvance:data.autoAdvance??server.autoAdvance,revision:server.revision+1};
  return new Response(JSON.stringify(server),{headers:{'Content-Type':'application/json'}});
 }
 if(path==='/api/sessions/fixture/ai/agentQuestionReply'&&init?.method==='POST'){
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

function Fixture(){
 const [settings,setSettings]=useState(server),[,render]=useState(0);
 const snapshot={session:{id:'fixture',projectId:'fixture'},ai:{profile:'core',status:'completed',agentRuns:[]},resources:[{id:'fixture-host',name:'隔离测试主机'}],sre:{enabled:settings.enabled,pilot:settings,tasks:[task]}} as SessionSnapshot;
 const refresh=async()=>{setSettings({...server});render(value=>value+1)};
 return <main style={{maxWidth:query.get('width')==='390'?390:900,margin:'28px auto',padding:'0 24px'}}>
  <p style={{color:'var(--text-muted)',fontSize:'var(--font-size-toolbar)'}}>Lake Pilot · 隔离测试数据，不连接实际资源</p>
  <div className="composer-foot" style={{margin:'16px 0 28px'}}><span>权限</span><LakePilotControl snapshot={snapshot} onUpdated={refresh}/></div>
  {query.get('view')==='choice'?<PilotChoiceQuestion request={choice} session="fixture" runId="logs" refresh={refresh}/>:task.messages.filter(message=>['scope','phenomenon','change','verify'].includes(message.attemptId??'')).map(entry=><SRERoleMessage key={entry.id} task={task} entry={entry} snapshot={snapshot} renderApproval={()=>null} onUpdated={()=>{}}/>)}
  <output aria-label="隔离请求统计" style={{color:'var(--text-muted)',fontSize:'var(--font-size-toolbar)',overflowWrap:'anywhere'}}>{JSON.stringify({requests,decisions,...settings})}</output>
 </main>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Fixture/></React.StrictMode>);
