// Real workspace hook and navigation; local synthetic responses, no backend.
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {PilotWorkspace,usePilotWorkspace} from '../../src/PilotWorkspace';
import type {SuperWorkspace} from '../../../shared/contracts';
import '../../src/styles.css';
import '../../src/pilotWorkspace.css';

const phases=['空闲','接单','执行','需确认','完成'] as const;
let phase:typeof phases[number]='空闲',stream:EventTarget|undefined;
const metrics={requests:0,changedAt:0};
Object.assign(window,{lakeSpecialistActivityQA:metrics});
class FixtureEvents extends EventTarget {
 constructor(){super();stream=this;queueMicrotask(()=>this.dispatchEvent(new Event('open')));}
 close(){if(stream===this)stream=undefined;}
}
window.EventSource=FixtureEvents as unknown as typeof EventSource;
window.fetch=async()=>{
 metrics.requests++;
 const workspace:SuperWorkspace={active:true,project:{projectId:'fixture',routerSessionId:'pilot',version:1},cursor:1,
  channels:[{id:'channel',roleId:'database',roleName:'数据库专员',projectId:'fixture',sessionId:'role-channel',revision:1,createdAt:'',preparing:phase==='接单',running:phase==='执行',needsConfirmation:phase==='需确认',completionCursor:phase==='完成'?'0001':undefined}],
  workers:[{id:'worker',roleId:'database',roleName:'数据库专员',sessionId:'worker-session',assignmentState:'parked',task:{taskId:'original-task',sessionId:'worker-session',title:'继续数据库比较任务',state:'blocked',acceptanceState:'insufficient',revision:1,originRootTurnId:'original-root',deadlineAt:''}}]};
 return Response.json(workspace);
};
if(new URLSearchParams(location.search).has('dark'))document.documentElement.dataset.theme='dark';
function Fixture(){
 const {workspace,error}=usePilotWorkspace('fixture',true);
 const [current,setCurrent]=useState<typeof phases[number]>('空闲');
 return <main style={{padding:20,color:'var(--foreground)',fontFamily:'var(--font-ui)'}}>
  <div style={{display:'flex',gap:8,flexWrap:'wrap',marginBottom:18}}>{phases.map(value=><button type="button" className="button" key={value} onClick={()=>{phase=value;metrics.changedAt=performance.now();setCurrent(value);stream?.dispatchEvent(new Event('specialist'));}}>{value}</button>)}</div>
  <div className="sidebar sidebar-open workspace-navigation" style={{width:'min(350px,100%)',height:'auto',minWidth:0,position:'relative',padding:0}}><PilotWorkspace workspace={workspace} error={error} selectedId="pilot" onPilot={()=>{}} onWorker={()=>{}}/></div>
  <p role="status" style={{color:'var(--text-muted)',marginTop:16}}>当前：{current} · 原任务保持待核实</p>
 </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
