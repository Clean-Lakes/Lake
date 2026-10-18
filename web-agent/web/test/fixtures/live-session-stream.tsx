// Full App integration with synthetic fetch/SSE. Never contacts a model or host.
import React from 'react';
import {createRoot} from 'react-dom/client';
import App from '../../src/App';
import type {SessionSnapshot} from '../../../shared/contracts';
import '../../src/theme.css';
import '../../src/styles.css';
import '../../src/assistantProse.css';
import '../../src/sreCollaboration.css';
import '../../src/statusText.css';
import '../../src/appSelect.css';
import '../../src/composerModelSelect.css';
import '../../src/providerIcon.css';
const params=new URLSearchParams(location.search);
document.documentElement.dataset.theme=params.get('theme')==='dark'?'dark':'light';
if(params.has('reduce')){const original=window.matchMedia.bind(window);window.matchMedia=query=>query==='(prefers-reduced-motion: reduce)'?{...original(query),matches:true,addEventListener(){},removeEventListener(){}} as MediaQueryList:original(query)}
const at=new Date(Date.now()-60000).toISOString(),started=new Date().toISOString();
const prose='历史正文保持稳定。\n\n| 项目 | 状态 |\n| --- | --- |\n| 服务 | 正常 |\n\n[查看历史证据](#record)';
const state={session:{id:'fixture',projectId:'p',title:'流式与刷新回归',status:'investigating',createdAt:at,updatedAt:at,tags:[]},cursor:1,resources:[],resourceTree:[],messages:[{id:'user',sessionId:'fixture',role:'user',text:'检查隔离测试服务',createdAt:at}],specialists:[],evidence:[],actions:[],terminals:[],ai:{session:'fixture',status:'running',rootTurnId:'turn',cards:[{id:'history',type:'message',content:prose,status:'completed',at}],cardsOffset:0,totalCards:1,turns:1,usage:{input:0,output:0,total:0},agentRuns:[{id:'role',sessionId:'fixture',sreTaskId:'task',rootTurnId:'turn',role:'host',name:'协调者',sreRole:'coordinator',status:'running',task:'检查状态',resourceIds:[],createdAt:started,startedAt:started,activityPhase:'waiting_model'}]},sre:{enabled:true,tasks:[{id:'task',sessionId:'fixture',projectId:'p',status:'active',revision:1,goal:'检查隔离测试服务',plans:[],runs:[{id:'plan-run'}],attempts:[{id:'attempt',planRunId:'plan-run',roleRunId:'role',status:'running',operations:[],evidence:[]}],messages:[{id:'progress',taskId:'task',sessionId:'fixture',roleId:'coordinator',roleRunId:'role',attemptId:'attempt',kind:'progress',source:'runtime',body:'正在等待模型输出。',sequence:1,revision:1,createdAt:started}]}]}} as unknown as SessionSnapshot;
const metrics={catalogs:0,snapshots:0,subscriptions:0,closes:0,historyReplacements:0,livePaints:0,partialPaints:0,replyPaints:0,replyPartialPaints:0,packets:0,errors:0};
class FixtureStream extends EventTarget {
 static OPEN=1;readyState=1;onopen:((e:Event)=>void)|null=null;onerror:((e:Event)=>void)|null=null;onmessage:((e:MessageEvent)=>void)|null=null;
 constructor(){super();metrics.subscriptions++;streams.add(this);setTimeout(()=>this.onopen?.(new Event('open')),10)}
 close(){streams.delete(this);metrics.closes++;this.readyState=2}
 emit(textUpdate?:import('../../../shared/contracts').SessionEvent['textUpdate']){this.dispatchEvent(new MessageEvent(textUpdate?'message':'session',{data:JSON.stringify({sessionId:'fixture',seq:state.cursor,type:textUpdate?'message':'session',textUpdate})}))}
}
const streams=new Set<FixtureStream>();
window.EventSource=FixtureStream as unknown as typeof EventSource;
window.fetch=async(input)=>{
 const path=String(input);let value:unknown={};
 if(path==='/api/bootstrap')value={authenticated:true,modelConfigured:true,modelName:'测试模型',modelId:'fixture',aiRuntime:'go',terminalMode:'pty'};
 else if(path==='/api/catalog'){metrics.catalogs++;value={projects:[{id:'p',name:'隔离测试',createdAt:at}],sessions:[state.session],resources:[],tags:[],terminals:[],resourceTree:[]}}
 else if(path.endsWith('/snapshot')){metrics.snapshots++;value=state}
 else if(path.includes('/presets'))value=[];
 else if(path.includes('/reasoning'))value={levels:[],effort:'',modelId:'fixture'};
 else if(path.includes('/models')||path.endsWith('/model/available'))value={models:['fixture'],entries:[]};
 else if(path.includes('/skills'))value={skills:[],roots:[]};
 else if(path.includes('/mcp'))value={servers:[]};
 else if(path.includes('/message-queue'))value={paused:false,revision:0,lastError:'',items:[]};
 return new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
};
window.addEventListener('error',()=>metrics.errors++);
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
let oldTable:Element|null=null,oldLink:Element|null=null,oldLive='',oldReply='';
function measure(){
 const table=document.querySelector('.assistant-prose table'),link=document.querySelector('.assistant-prose a');
 if(oldTable&&table!==oldTable)metrics.historyReplacements++;
 if(oldLink&&link!==oldLink)metrics.historyReplacements++;
 oldTable=table;oldLink=link;
 const live=document.querySelector('#sre-message-progress .sre-prose')?.textContent??'';
 if(state.ai!.agentRuns![0]!.liveText&&live!==oldLive){metrics.livePaints++;if(live&&live.length<state.ai!.agentRuns![0]!.liveText!.length)metrics.partialPaints++}
 oldLive=live;const reply=Array.from(document.querySelectorAll('.ai-response .assistant-prose')).at(-1)?.textContent??'';const source=state.ai!.cards.find(c=>c.id==='new-reply')?.content;if(source&&reply!==oldReply){metrics.replyPaints++;if(reply&&reply.length<source.length)metrics.replyPartialPaints++}oldReply=reply;document.getElementById('metrics')!.textContent=JSON.stringify(metrics);requestAnimationFrame(measure);
}
requestAnimationFrame(measure);
document.getElementById('start-stream')!.onclick=()=>{
 let index=0;const chunks=['正在逐步核对服务、日志和资源占用，先确认观察事实。','接着比对时间顺序，并保留尚未验证的假设。','中文与表情 👩🏽‍💻 都应完整呈现，正文不会整句替换。'];
 const timer=setInterval(()=>{if(index===chunks.length){clearInterval(timer);return}const run=state.ai!.agentRuns![0]!;run.liveTextId='live-reply';run.liveText=(run.liveText??'')+chunks[index++];let card=state.ai!.cards.find(c=>c.id==='new-reply');if(!card){card={id:'new-reply',type:'message',status:'running',content:'',at:new Date().toISOString()};state.ai!.cards.push(card);state.ai!.totalCards++}card.content=run.liveText;state.cursor++;streams.forEach(s=>s.emit({target:'agent',id:run.id,textId:run.liveTextId,content:run.liveText!}));state.cursor++;streams.forEach(s=>s.emit({target:'card',id:card.id,cardType:card.type,content:card.content!,at:card.at,rootTurnId:'turn'}));metrics.packets++},150);
};
document.getElementById('finish-stream')!.onclick=()=>{state.ai!.status='completed';state.ai!.cards.forEach(card=>card.status='completed');state.ai!.agentRuns![0]!.status='completed';state.sre!.tasks[0]!.status='paused';state.cursor++;streams.forEach(s=>s.emit())};
document.getElementById('recover-stream')!.onclick=()=>{streams.forEach(s=>{s.readyState=0;s.onerror?.(new Event('error'));setTimeout(()=>{s.readyState=1;s.onopen?.(new Event('open'))},50)})};
