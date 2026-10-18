import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {AITranscript} from '../../src/AIPanel';
import {SessionStateBadge} from '../../src/SessionPresentation';
import {sreSessionPresentation} from '../../src/sreSessionPresentation';
import type {SessionSnapshot,SRETask} from '../../../shared/contracts';
import '../../src/theme.css';
import '../../src/styles.css';
import '../../src/sreCollaboration.css';
import '../../src/statusText.css';
const at='2026-10-18T08:00:00Z';
document.documentElement.dataset.theme=new URLSearchParams(location.search).get('theme')==='dark'?'dark':'light';
function Fixture(){
 const [mode,setMode]=useState('read');
 const running=mode==='running',success=mode==='success',change=mode==='change';
 const op={id:'original',call:{id:'original',name:'shell',arguments:JSON.stringify({command:change?'systemctl restart fixture.service':'uptime; systemctl --failed; podman ps -a'})},digest:'sample',resourceId:'host',risk:change?'dangerous':'readonly',status:running?'dispatched':success?'succeeded':'unknown',preparedAt:at,result:running?'原命令仍有终端与执行记录句柄':success?'实际采样已完成':'context deadline exceeded'};
 const task={id:'task',sessionId:'session',projectId:'test',status:success?'completed':'paused',outcome:success?'supported':'',goal:'核对测试主机状态',scope:['host'],mode:'assist',revision:1,budgetSpent:0,tokenBudget:128000,plans:[{id:'plan',version:1,goal:'核对测试主机状态',scope:['host'],steps:[{id:'observe',role:'investigator',kind:'observe',capability:'host',description:'取得当前主机状态',resourceIds:['host'],dependsOn:[],completionChecks:['真实命令结果']}]}],runs:[{id:'run',planRevisionId:'plan',status:success?'completed':'paused'}],attempts:[{id:'attempt',stepId:'observe',planRunId:'run',roleRunId:'role',status:success?'succeeded':running||change?'unknown':'failed',evidence:[],operations:[op],startedAt:at}],messages:[{id:'plan-message',sessionId:'session',taskId:'task',roleId:'coordinator',roleRunId:'role',kind:'plan',body:'按当前实际操作记录继续检查。',revision:1,sequence:1,createdAt:at},{id:'result',sessionId:'session',taskId:'task',roleId:'investigator',roleRunId:'role',attemptId:'attempt',kind:success?'finding':'error',body:running?'原操作仍在运行，等待原句柄结果。':success?'重新采样完成，结果有实际操作记录支持。':change?'变更操作结果不明，需要核实原操作实际状态。':'只读检查未完成，可重新检查；原始超时记录已保留。',revision:1,sequence:2,createdAt:at}],verifications:[]} as unknown as SRETask;
 const snapshot={session:{id:'session',projectId:'test',status:success?'completed':'failed'},messages:[{id:'user',role:'user',sessionId:'session',text:'再检查一次测试主机',createdAt:at}],resources:[{id:'host',name:'隔离测试主机'}],actions:[],terminals:[],evidence:[],ai:{session:'session',status:success?'completed':'failed',cards:[],agentRuns:[],cardsOffset:0,totalCards:0,usage:{input:0,output:0,total:0},turns:1},replyTimings:[{messageId:'user',startedAt:at,finishedAt:'2026-10-18T08:00:03Z',status:success?'completed':'failed'}],sre:{enabled:true,tasks:[task]}} as unknown as SessionSnapshot;
 return <main style={{maxWidth:1000,margin:'24px auto',padding:'0 24px'}}><h2>SRE 操作状态 · 隔离验收数据</h2><p>只展示真实组件；此页面不会连接或执行服务器命令。</p><nav style={{display:'flex',gap:12,marginBottom:24}}>{[['read','只读超时'],['change','变更结果不明'],['running','原命令运行中'],['success','采样成功']].map(([key,title])=><button key={key} onClick={()=>setMode(key)}>{title}</button>)}</nav><SessionStateBadge session={snapshot.session} {...sreSessionPresentation(snapshot.session,[task])}/><AITranscript snapshot={snapshot} onUpdated={()=>{}}/></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
