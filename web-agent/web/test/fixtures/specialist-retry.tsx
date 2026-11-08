// Production channel, fictional protocol data. No model or resource operations.
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {SpecialistChannel} from '../../src/SpecialistChannel';
import {specialistReplyId} from '../../../shared/specialist-replies';
import type {SessionSnapshot,SpecialistChannelEntry,SpecialistChannelPage,SuperWorker} from '../../../shared/contracts';
import '../../src/styles.css';
import '../../src/conversationBubbles.css';
import '../../src/assistantProse.css';
import '../../src/specialistChannel.css';
import '../../src/agentQuestion.css';

let stage=0;
const at='2026-11-07T08:00:00Z',retryAt='2026-11-07T09:00:00Z';
const labels=['历史失败','Pilot 重试','更新进展','完成总结','另一项任务待确认'];
const metrics={requests:0,animations:0,replacements:0,requestedAt:[] as number[],delayed:false};
const nativeAnimate=Element.prototype.animate;
Element.prototype.animate=function(...args:Parameters<Element['animate']>){metrics.animations++;return nativeAnimate.apply(this,args)};
Object.assign(window,{lakeRetryQA:metrics});
const worker:SuperWorker={id:'worker',sessionId:'source',roleId:'knowledge',roleName:'知识库专员',assignmentState:'active',task:{taskId:'task',sessionId:'source',title:'查询知识库文档数量',state:'running',acceptanceState:'not_evaluated',revision:1,originRootTurnId:'original',deadlineAt:''}};
const settled=(turn:string,time:string,text:string):SpecialistChannelEntry=>({id:specialistReplyId('source',turn),sourceSessionId:'source',taskId:'task',workerId:'worker',createdAt:time,reply:{turnId:turn,state:'settled'},message:{id:'report-'+turn,sessionId:'channel',role:'assistant',text,createdAt:time,author:{kind:'specialist',name:'知识库专员',workerId:'worker',sessionId:'source',taskId:'task',rootTurnId:turn}}});
function page():SpecialistChannelPage{
 const old=settled('old',at,'上次查询未完成：当时知识库连接不可用。');
 const working=stage===1||stage===2;
 const cards=[{id:'progress',type:'message',status:'completed',at:retryAt,content:stage===1?'正在检查知识库连接…':'连接已恢复，正在统计文档数量。',data:{root_turn_id:'retry'}}];
 const active={session:{id:'source'},messages:[],resources:[],ai:{session:'source',status:'running',rootTurnId:'retry',turnStartedAt:retryAt,cards},superagent:{task:worker.task}} as unknown as SessionSnapshot;
 const other={...worker,id:'other',sessionId:'other',task:{...worker.task,taskId:'other-task',sessionId:'other',title:'核对另一项查询',state:'waiting_user'}} as SuperWorker;
 const question={...active,session:{id:'other'},superagent:{task:other.task},ai:{...active.ai!,status:'waiting_input',rootTurnId:'other-turn',cards:[],question:{id:'question',questions:[{id:'scope',title:'另一项查询需要你确认范围',options:[{label:'当前集合'}]}]}}} as SessionSnapshot;
 return {replyPresentation:'invocation',channel:{id:'channel',sessionId:'channel',projectId:'fixture',roleId:'knowledge',roleName:'知识库专员',revision:1,createdAt:at},entries:[old,...(stage>=3?[settled('retry',retryAt,'当前可访问的知识库共有 66 个已发布文档，包含子文档；草稿和归档文档不计入。')]:[])],active:working?[active]:stage===4?[question]:[],workers:stage===4?[worker,other]:[worker],routing:false,queued:0,nextCursor:''};
}
window.fetch=async(input)=>{
 const path=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href).pathname;
 if(path.endsWith('/channel')){metrics.requests++;metrics.requestedAt.push(performance.now());const value=page();if(metrics.delayed){metrics.delayed=false;await new Promise(resolve=>setTimeout(resolve,300));}return Response.json(value);}
 return Response.json({});
};
function Fixture(){
 const [cursor,setCursor]=useState(1);
 const change=(next:number)=>{stage=next;setCursor(value=>value+1);};
 Object.assign(window,{lakeRetryAdvance:change});
 const snapshot={session:{id:'channel',projectId:'fixture',title:'知识库专员',workspaceRole:'role'},messages:[],resources:[],cursor} as unknown as SessionSnapshot;
 return <main style={{maxWidth:880,margin:'0 auto',padding:'24px 20px'}}>
  <header style={{display:'flex',gap:8,flexWrap:'wrap',marginBottom:32}}>{labels.map((label,index)=><button key={label} onClick={()=>change(index)}>{label}</button>)}<button onClick={()=>{document.documentElement.dataset.theme=document.documentElement.dataset.theme==='dark'?'light':'dark'}}>切换主题</button></header>
  <p style={{color:'var(--text-muted)',fontSize:12}}>隔离界面验证 · 数据为虚构样例</p>
  <section className="conversation" style={{height:'auto',padding:0,overflow:'visible'}}><SpecialistChannel snapshot={snapshot} connected onTask={()=>{}}/></section>
 </main>;
}
document.documentElement.dataset.theme='light';
createRoot(document.getElementById('root')!).render(<Fixture/>);
