// Real channel renderer, fictional immutable records. No API or model calls.
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import type {SpecialistChannelEntry,SuperWorker} from '../../../shared/contracts';
import {SpecialistChannelEntries} from '../../src/SpecialistChannel';
import '../../src/styles.css';
import '../../src/conversationBubbles.css';
import '../../src/assistantProse.css';
import '../../src/specialistChannel.css';
import '../../src/externalAgents.css';
import '../../src/providerIcon.css';

document.documentElement.dataset.theme=new URLSearchParams(location.search).get('theme')==='dark'?'dark':'light';
function assigned(id:string,title:string,at:string,codex=false,queued=false):SuperWorker{
 return {id,createdAt:at,roleId:'ops',roleName:'服务器运维专员',sessionId:`worker-${id}`,assignmentState:queued?'queued':'parked',task:{taskId:`task-${id}`,sessionId:`worker-${id}`,title,state:queued?'queued':'completed',acceptanceState:queued?'not_evaluated':'pass',revision:1,originRootTurnId:`root-${id}`,deadlineAt:''},execution:{backend:codex?{kind:'acp',agent:'codex',revision:2}:{kind:'native'},source:'specialist_default',assignedAt:at,totalRuns:codex&&!queued?1:0,runs:codex&&!queued?[{id:`run-${id}`,agent:'codex',scope:'worker',state:'completed',dispatchPhase:'answered',createdAt:at,updatedAt:at,summary:'展示夹具：独立 Codex 已回传指定测试证据。',usage:null}]:[]}};
}
const workers=[assigned('old-a','旧服务器资源检查','2026-11-05T08:00:00Z'),assigned('old-b','旧云主机巡检','2026-11-06T01:00:00Z'),assigned('old-c','旧整体情况分析','2026-11-06T02:00:00Z'),assigned('current','新的只读验证','2026-11-11T01:14:24Z',true)];
const reply=(worker:SuperWorker,text:string):SpecialistChannelEntry=>({id:`reply-${worker.id}`,sourceSessionId:worker.sessionId,taskId:worker.task.taskId,createdAt:worker.createdAt!,reply:{turnId:`turn-${worker.id}`,state:'settled'},message:{id:`message-${worker.id}`,sessionId:worker.sessionId,role:'assistant',createdAt:worker.createdAt!,text}});
function Fixture(){
 const [older,setOlder]=useState(false),[queued,setQueued]=useState(false),[received,setReceived]=useState(false),[selected,setSelected]=useState('');
 const next=assigned('queued','排队的新 Codex 任务','2026-11-11T01:16:00Z',true,!received);
 return <main style={{height:'100vh',overflow:'auto',padding:'20px clamp(12px,4vw,40px)'}}><div style={{maxWidth:900,margin:'0 auto'}}>
  <header style={{display:'flex',flexWrap:'wrap',gap:8,marginBottom:16}}><button onClick={()=>setOlder(value=>!value)}>加载更早记录</button><button onClick={()=>setQueued(true)}>显示排队任务</button><button onClick={()=>setReceived(true)} disabled={!queued}>收到排队回复</button><button onClick={()=>{document.documentElement.dataset.theme=document.documentElement.dataset.theme==='dark'?'light':'dark';}}>切换主题</button></header>
  <p>界面展示夹具，不调用模型或服务器。旧原生任务保留历史绑定，新的 Codex 回复位于对应时间位置。</p>
  <section className="conversation" style={{height:'auto',overflow:'visible',padding:0}}><SpecialistChannelEntries entries={[reply(workers[3]!,'新的 Codex 已完成只读验证，并回传了指定测试文件内容。'),...(queued&&received?[reply(next,'排队的 Codex 已回传结果。')]:[])]} workers={[...workers,...(queued?[next]:[])]} resources={[]} hasOlder={!older} onTask={setSelected}/></section>
  <output aria-label="打开的原任务">{selected}</output>
 </div></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
