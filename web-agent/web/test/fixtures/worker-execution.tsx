// Synthetic task inspector fixture. It makes no backend or resource requests.
import {useEffect,useState,type CSSProperties} from 'react';
import {createRoot} from 'react-dom/client';
import type {AICard,AgentRun,ResourceTreeNode,SessionSnapshot,SuperWorker} from '../../../shared/contracts';
import {SessionInspector} from '../../src/SessionInspector';
import {SessionInspectorProvider,useSessionInspector} from '../../src/SessionInspectorContext';
import {Glyph} from '../../src/Icons';
import {AgentExecution} from '../../src/AgentExecution';
import '../../src/externalAgents.css';
import '../../src/styles.css';
import '../../src/sessionInspector.css';
import '../../src/pilotWorkspace.css';

const query=new URLSearchParams(location.search),completed=query.has('completed');
document.documentElement.dataset.theme=query.get('theme')??'light';
const at='2026-11-06T00:00:00Z';
const resource=(id:string,name:string,kind='ssh')=>({id,name,projectId:'project',kind,status:'available'});
const resources=[resource('jd-host','应用服务器'),resource('jd-db','MySQL 8','mysql'),resource('uc-host','应用服务器')];
const folder=(id:string,name:string,parentId:string|null=null):ResourceTreeNode=>({id,projectId:'project',kind:'folder',name,parentId,resourceId:null,position:0});
const leaf=(resourceId:string,parentId:string):ResourceTreeNode=>({id:`node-${resourceId}`,projectId:'project',kind:'resource',name:'',parentId,resourceId,position:0});
const tree=[folder('production','生产环境'),folder('jd','京东云','production'),folder('db','数据库','jd'),folder('uc','优刻云','production'),leaf('jd-host','jd'),leaf('jd-db','db'),leaf('uc-host','uc')];
const call=(id:string,resourceId:string,title:string,content:string,status='completed'):AICard=>({id,type:'operation',title,status,content,at,data:{taskId:'task',operation_id:`fixture-operation-${id}`,resource_id:resourceId,arguments:{asset_ref:resourceId,metric:'system'}}});
const run=(id:string,name:string,resourceIds:string[],cards:AICard[],status='completed'):AgentRun=>({id,source:'native_subagent',taskId:'task',workerId:'worker',sessionId:`child-${id}`,childSessionId:`child-${id}`,role:'general-purpose',name,task:`只读完成${name}并交付实际采样结果`,resourceIds,cards,status,toolCount:cards.length,createdAt:at,startedAt:at,...(status==='completed'?{finishedAt:'2026-11-06T00:00:32Z',summary:'已采集结果，保留准确资源与工具回执。'}:{})});
const runs=[run('system','系统指标检查',['jd-host'],[call('sys','jd-host','inspect_host','平均负载 0.00 / 0.02 / 0.09；可用内存 2.47 GiB；根分区使用率 18%。')]),run('database','数据库只读检查',['jd-db'],[call('sql','jd-db','call_mcp_tool','连接数 18，查询延迟 4ms。')]),run('uc-system','系统指标检查',['uc-host'],[call('uc-sys','uc-host','inspect_host','CPU 2%，可用内存 3.10 GiB。')]),run('compare','跨资源比较与复核',['jd-host','uc-host'],[call('compare-a','jd-host','inspect_host','重新采样：根分区使用率 18%。'),call('compare-b','uc-host','inspect_host',completed?'重新采样：根分区使用率 21%。':'正在读取根分区指标。',completed?'completed':'running')],completed?'completed':'running')];
const task={taskId:'task',sessionId:'session',projectId:'project',title:'分析多云服务器整体情况',state:completed?'completed':'running',acceptanceState:completed?'pass':'not_evaluated',revision:3,originRootTurnId:'root',deadlineAt:'2026-11-07T00:00:00Z',summary:completed?'两组服务器资源压力不明显，数据库采样正常。本次只读检查已完成；未覆盖业务服务可用性。':undefined};
const snapshot={session:{id:'session',projectId:'project',title:task.title,workspaceRole:'worker'},superagent:{task,goal:{id:'task',sessionId:'session',originRootTurnId:'root',title:task.title,status:task.state,revision:3,items:[{id:'check',title:'只读采样系统指标并比较当前结果',status:completed?'completed':'running'}],modelRounds:8,roundLimit:500,deadlineAt:task.deadlineAt,updatedAt:at}},resources,resourceTree:tree,messages:[],actions:[],terminals:[],specialists:[],evidence:[],ai:{session:'session',cards:[],agentRuns:runs,status:task.state,turns:1,usage:{},profile:'default',cardsOffset:0,totalCards:0}} as unknown as SessionSnapshot;
const worker={id:'worker',roleId:'role',roleName:'服务器运维排查专员',sessionId:'session',task:snapshot.superagent!.task,assignmentState:completed?'stopped':'active'} as SuperWorker;
// Optional ACP motion proof refreshes cloned snapshots once a second while
// retaining the exact task/card IDs. It never calls a real Agent or backend.
if(query.has('acp-motion')){
 snapshot.ai!.agentRuns=[];
 const run={id:'fixture-acp-run',agent:'codex' as const,scope:'worker' as const,state:completed?'completed' as const:'running' as const,dispatchPhase:completed?'answered' as const:'sent' as const,createdAt:at,updatedAt:at,summary:completed?'展示夹具：外部执行已结束。':undefined,usage:null};
 snapshot.superagent!.execution={backend:{kind:'acp',agent:'codex',revision:2},source:'task_assignment',assignedAt:at,runs:[run],totalRuns:1};
 snapshot.ai!.cards.push({id:run.id,type:'operation',title:'Codex · ACP',status:run.state,at,content:run.summary??'展示夹具：等待外部执行回传。',data:{source:'external_agent',external_agent:'codex',external_run_id:run.id,taskId:'task'}});
}
function Fixture(){
 const inspector=useSessionInspector()!;
 const [refresh,setRefresh]=useState(0);
 useEffect(()=>{if(!query.has('acp-motion'))return;const timer=setInterval(()=>setRefresh(value=>value+1),1000);return()=>clearInterval(timer);},[]);
 const current=query.has('acp-motion')?{...snapshot,cursor:refresh,ai:{...snapshot.ai!,cards:snapshot.ai!.cards.map(card=>({...card})),agentRuns:snapshot.ai!.agentRuns?.map(run=>({...run}))}}:snapshot;
 useEffect(()=>{inspector.open({sessionId:'session',canonicalGoalId:'task',tab:'execution'});},[]);
 return <main data-fixture-refresh={refresh} className="worker-fixture" style={{'--inspector-preferred-width':'520px'} as CSSProperties}>
  <style>{`.worker-fixture{display:flex;height:100%;background:var(--sidebar);color:var(--foreground)}.worker-fixture-nav{width:250px;flex:none;border-right:1px solid var(--border);padding:26px 14px;overflow:auto}.worker-fixture-nav h1{font-size:23px;margin:0 0 35px}.worker-fixture-nav h1 small{font-size:11px;color:var(--text-muted);padding:4px 6px;background:var(--surface-hover);border-radius:5px}.worker-fixture-nav p{padding:10px 8px;margin:0;display:flex;gap:10px;align-items:center}.worker-fixture-nav .selected{background:var(--surface-selected);border-radius:14px}.worker-fixture-nav h4{font-size:12px;color:var(--text-muted);font-weight:400;margin:28px 8px 12px}.worker-fixture-body{position:relative;display:flex;min-width:0;flex:1}.worker-fixture-conversation{flex:1;min-width:0;display:flex;flex-direction:column;padding:28px 28px 22px;overflow:auto}.worker-fixture-island{align-self:flex-start;padding:12px 16px;border:1px solid var(--border);border-radius:20px;font-size:14px;box-shadow:0 3px 15px #00000005}.worker-fixture-task{margin-top:24px;border:0;border-radius:10px;background:var(--surface-hover);padding:12px;text-align:left;color:var(--foreground);display:flex;align-items:center;justify-content:space-between;gap:10px}.worker-fixture-chat{padding-top:42px;line-height:1.9;font-size:14px}.worker-fixture-chat p{margin:0 0 28px}.worker-fixture-chat .notice{color:var(--text-muted);border-left:2px solid var(--border);padding-left:12px}.worker-fixture-composer{margin-top:auto;padding:14px;border:1px solid var(--border);border-radius:18px;color:var(--text-muted);font-size:13px}.worker-fixture .session-inspector{padding-top:16px;padding-bottom:16px}.worker-fixture .session-inspector-card{flex:1}.worker-fixture-title{font-size:13px;color:var(--text-muted);margin-bottom:24px}.worker-fixture .session-inspector-scroll{padding:18px 20px}@media(max-width:1100px){.worker-fixture-nav{width:200px}.worker-fixture .session-inspector{width:min(520px,100%);background:var(--sidebar)}}@media(max-width:700px){.worker-fixture-nav{display:none}.worker-fixture-conversation{padding:20px}}`}</style>
  <nav className="worker-fixture-nav"><h1>Lake <small>Dev</small></h1><p><Glyph name="lakePilot"/>Pilot</p><h4>专员</h4><p className="selected"><Glyph name="lakeActivity"/>服务器运维排查专员</p><p><Glyph name="lakeWorkflow"/>发布专员</p><p><Glyph name="lakeDatabase"/>数据库专员</p><h4>资源</h4><p><Glyph name="folder"/>生产环境</p><p style={{paddingLeft:26}}><Glyph name="folder"/>京东云</p><p style={{paddingLeft:42}}><Glyph name="server"/>应用服务器</p><p style={{paddingLeft:42}}><Glyph name="database"/>MySQL 8</p><p style={{paddingLeft:26}}><Glyph name="folder"/>优刻云</p><p style={{paddingLeft:42}}><Glyph name="server"/>应用服务器</p></nav>
  <div className="worker-fixture-body"><section className="worker-fixture-conversation"><div className="worker-fixture-island">服务器运维排查专员 · {completed?'已完成':'执行中'}</div><button className="worker-fixture-task" onClick={()=>inspector.open({sessionId:'session',canonicalGoalId:'task',tab:'execution'})}>分析多云服务器整体情况<Glyph name="panel" size={15}/></button>{query.has('acp-motion')&&<AgentExecution execution={current.superagent?.execution} roleName={worker.roleName}/>}<div className="worker-fixture-chat"><p>对比京东云和优刻云的服务器运行情况，并检查数据库，只读检查。</p><strong>服务器运维排查专员</strong><p>系统指标和数据库已完成采样，正在独立比较两组服务器的当前结果。</p><p>京东云服务器资源压力不明显，根分区使用率为 18%。数据库当前连接数为 18，查询采样正常。</p><p className="notice">本次为系统采样，业务服务可用性尚未验证。</p></div><div className="worker-fixture-composer">想让 Lake 帮你做什么？</div></section><SessionInspector snapshot={current} worker={worker} connected={false} onUpdated={()=>{}}/></div>
 </main>;
}
createRoot(document.getElementById('root')!).render(<SessionInspectorProvider><Fixture/></SessionInspectorProvider>);
