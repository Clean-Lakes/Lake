// Fictional project fixture: no backend, model or infrastructure calls.
import {createRoot} from 'react-dom/client';
import App from '../../src/App';
import type {ScheduledTask} from '../../../shared/contracts';
import {setThemePreference} from '../../src/appearance';
import '../../src/theme.css';import '../../src/styles.css';import '../../src/assistantProse.css';import '../../src/appSelect.css';
const query=new URLSearchParams(location.search);setThemePreference(query.has('dark')?'dark':'light');
const date='2026-10-19T15:00:00+08:00';const metrics={patches:0,created:0,lastPatch:null as unknown,navigated:false,listReads:0};
const tasks:ScheduledTask[]=query.has('empty')?[]:[{id:'inspection',project_id:'p',session_id:'source',name:'演示集群健康巡检',kind:'workflow',interval_seconds:600,enabled:true,status:'completed',revision:4,at:date,last_at:'2026-10-19T14:50:00+08:00',history_count:2,history:[{id:'older',scheduled_at:date,started_at:'2026-10-19T14:40:00+08:00',finished_at:'2026-10-19T14:40:09+08:00',status:'failed',error:'演示连接不可用',session_id:'source'},{id:'latest',scheduled_at:date,started_at:'2026-10-19T14:50:00+08:00',finished_at:'2026-10-19T14:50:06+08:00',status:'completed',session_id:'execution'}]},{id:'reminder',project_id:'p',session_id:'source',name:'核对演示环境变更',kind:'reminder',message:'确认演示服务的变更记录。',interval_seconds:0,enabled:false,status:'scheduled',revision:1,at:date,history_count:0,history:[]}];
const session={id:'source',projectId:'p',title:'演示巡检会话',status:'completed',createdAt:date,updatedAt:date,tags:[]};
const execution={...session,id:'execution',title:'演示执行结果'};
const snapshot={session,messages:[],resources:[],resourceTree:[],evidence:[],actions:[],terminals:[],specialists:[],ai:{session:'source',status:'idle',cards:[],cardsOffset:0,turns:0,usage:{input:0,output:0,total:0}},messageQueue:{items:[],paused:false,revision:0,lastError:''},sre:{enabled:false,tasks:[]}};
window.EventSource=class extends EventTarget{readyState=1;onopen:null=null;onmessage:null=null;onerror:null=null;close(){}} as unknown as typeof EventSource;
window.fetch=async(input,init)=>{
 const path=new URL(String(input),location.href).pathname;let value:unknown={};let status=200;
 if(path==='/api/bootstrap')value={authenticated:true,modelConfigured:true,modelName:'演示模型',modelId:'fixture',aiRuntime:'adk',terminalMode:'pty'};
 else if(path==='/api/catalog')value={projects:[{id:'p',name:'演示工作区',createdAt:date}],sessions:[session,execution],resources:[],resourceTree:[],tags:[],terminals:[]};
 else if(path.endsWith('/schedules')){metrics.listReads++;if(query.has('error')){value={error:'演示：任务读取失败，请重试'};status=503}else value={items:tasks.map(({history,...item})=>item)}}
 else if(path.includes('/schedules/')){const task=tasks.find(item=>path.endsWith('/'+item.id))!;if(init?.method==='PATCH'){metrics.patches++;metrics.lastPatch=JSON.parse(String(init.body));if(query.has('conflict')){status=409;value={error:'任务状态已变化，请刷新后重试'}}else {task.enabled=(metrics.lastPatch as {enabled:boolean}).enabled;task.revision++;value=task}}else value=task}
 else if(path.endsWith('/snapshot')){const result=path.includes('/execution/');value=result?{...snapshot,session:execution}:snapshot;metrics.navigated=metrics.navigated||result}
 else if(path.includes('/reasoning'))value={levels:[],effort:'',modelId:'fixture'};
 else if(path.endsWith('/message-queue'))value=snapshot.messageQueue;
 else if(path.includes('/skills'))value={skills:[],roots:[]};else if(path.includes('/mcp'))value={servers:[]};else if(path.endsWith('/available')||path.includes('/presets')||path.includes('/references'))value=[];
 document.getElementById('schedule-fixture-results')!.textContent=JSON.stringify(metrics);
 return new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
};
createRoot(document.getElementById('root')!).render(<App/>);
