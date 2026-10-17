// Real transcript components with synthetic persisted records; no resource operations.
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {AITranscript} from '../../src/AIPanel';
import {roleReport,reportEvidence} from './sre-report';
import type {SessionSnapshot,SRETask} from '../../../shared/contracts';
import '../../src/theme.css';
import '../../src/styles.css';
import '../../src/sreCollaboration.css';
import '../../src/conversationDirectory.css';
import '../../src/statusText.css';
document.documentElement.dataset.theme=new URLSearchParams(location.search).get('theme')==='dark'?'dark':'light';
const at='2026-10-16T05:00:00Z';
const steps=[{id:'disk',role:'investigator',kind:'observe',description:'核对磁盘与 inode'},{id:'analysis',role:'coordinator',kind:'analyze',description:'分析服务与磁盘之间的关联'},{id:'final',role:'coordinator',kind:'summarize',description:'给出任务最终结论'}].map((s,i)=>({...s,resourceIds:['test-host'],dependsOn:i?[['disk','analysis'][i-1]]:[],completionChecks:['基于实际证据']}));
const legacyBody='服务和磁盘交叉分析。\n\n'+Array.from({length:12},()=> '这是原来重复输出的详细分析记录，现默认折叠保留，不再占满对话。').join('\n\n');
const nodeBody='服务与磁盘指标相互印证，未发现容量瓶颈；仍需历史监控判断增长趋势。';
const messages=[{id:'disk-done',roleId:'investigator',roleRunId:'disk',attemptId:'disk',kind:'status',source:'runtime',body:'本步工作已完成。'},{id:'disk-result',roleId:'investigator',roleRunId:'disk',attemptId:'disk',kind:'finding',body:roleReport.summary},{id:'analysis-result',roleId:'coordinator',roleRunId:'analysis',attemptId:'analysis',kind:'summary',body:nodeBody},{id:'final-result',roleId:'coordinator',roleRunId:'final',attemptId:'final',kind:'summary',body:'检查完成：核心服务运行正常，当前磁盘空间充足。\n\n- 根分区使用率 17%，inode 使用率 3%，未发现容量耗尽风险。\n- 尚缺历史趋势，不能判断后续增长速度。\n- 建议持续观察磁盘增长；本次未执行变更。'}].map((m,i)=>({...m,sessionId:'session',taskId:'task',revision:1,sequence:i+1,createdAt:new Date(Date.parse(at)+i*60000).toISOString()}));
const task={id:'task',sessionId:'session',status:'completed',recoveryStatus:'not_applicable',rootCauseStatus:'unknown',goal:'检查测试服务',scope:['test-host'],revision:1,plans:[{id:'plan',steps}],runs:[{id:'run',planRevisionId:'plan',status:'completed'}],attempts:steps.map(s=>({id:s.id,stepId:s.id,planRunId:'run',roleRunId:s.id,status:'succeeded',evidence:s.id==='disk'?reportEvidence:[],operations:[],startedAt:at,...(s.id==='disk'?{report:roleReport}:{})})),messages,verifications:[]} as SRETask;
const snapshot={session:{id:'session',projectId:'test'},cursor:1,messages:[{id:'user',role:'user',sessionId:'session',text:'检查测试服务器的服务和磁盘状态。',createdAt:new Date(Date.parse(at)-1000).toISOString()}],resources:[{id:'test-host',name:'测试服务器'}],actions:[],terminals:[],evidence:[],ai:{session:'session',status:'completed',cards:[],agentRuns:[],usage:{input:0,output:0,total:0},profile:'core',cardsOffset:0,totalCards:0,turns:1},sre:{enabled:true,tasks:[task]}} as SessionSnapshot;
function Fixture(){const [legacy,setLegacy]=useState(false);const current={...snapshot,sre:{...snapshot.sre!,tasks:[{...task,messages:task.messages.map(m=>m.id==='analysis-result'?{...m,body:legacy?legacyBody:nodeBody}:m)}]}};return <main style={{maxWidth:900,margin:'24px auto',padding:'0 24px'}}><p style={{color:'var(--text-muted)',fontSize:11}}>节点小结与结束总结 · 隔离测试数据</p><button type="button" onClick={()=>setLegacy(!legacy)}>{legacy?'显示简短节点':'切换为历史长篇'}</button><AITranscript snapshot={current}/></main>}
createRoot(document.getElementById('root')!).render(<Fixture/>);
