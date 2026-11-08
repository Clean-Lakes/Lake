// Production channel and an in-memory protocol fixture. No actual task runs.
import {useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import type {AICard,SessionSnapshot,SpecialistChannelEntry,SpecialistChannelPage,SuperWorker} from '../../../shared/contracts';
import {SpecialistChannel} from '../../src/SpecialistChannel';
import {channelCardEntryId} from '../../src/specialistChannelProjection';
import '../../src/styles.css';
import '../../src/conversationBubbles.css';
import '../../src/assistantProse.css';
import '../../src/specialistChannel.css';
import '../../src/agentQuestion.css';

document.documentElement.dataset.theme=new URLSearchParams(location.search).get('theme')==='dark'?'dark':'light';
const stages=['首段流式','追加正文','工具执行','继续回答','完成落盘','失败收尾','取消收尾','双任务同CardID','加载早期历史','等待审批','等待回答','主机指纹'];
let stage=0;
const at='2026-11-06T08:00:00Z',source='worker-a';
const metrics={requests:0,actions:[] as string[],sameEntryNode:true,sameCardNode:true,entryReplacements:0,cardReplacements:0};
let originalEntry:Element|null=null,originalCard:Element|null=null;
Object.assign(window,{lakeChannelContinuityQA:metrics});
const worker=(id=source):SuperWorker=>({id:`worker-${id}`,roleId:'role',roleName:'服务器运维专员',sessionId:id,assignmentState:[4,5,6].includes(stage)?'parked':'active',task:{taskId:`task-${id}`,projectId:'project',sessionId:id,title:id===source?'检查服务器整体情况':'检查另一台服务器',state:stage===4?'completed':stage===5?'failed':stage===6?'cancelled':stage>=9?'waiting_user':'running',acceptanceState:stage===4?'pass':'not_evaluated',revision:1,originRootTurnId:`root-${id}`,deadlineAt:''}});
function cards():AICard[]{
 const first:AICard={id:'shared-card',at,type:'message',status:stage<2?'running':stage===5?'failed':stage===6?'cancelled':'completed',content:stage===0?'我已经连接到服务器。':'我已经连接到服务器。接下来检查当前的资源使用情况。'};
 const tool:AICard={id:'tool',at:'2026-11-06T08:00:01Z',type:'operation',title:'inspect_host',status:stage===2?'running':'completed',content:'Synthetic host metric receipt'};
 const final:AICard={id:'final',at:'2026-11-06T08:00:02Z',type:'message',status:stage===4?'completed':'running',content:'当前 CPU 和内存使用正常，磁盘还有充足空间。'};
 return stage>=2&&stage<=4?[first,tool,...(stage>=3?[final]:[])]:[first];
}
function active(id=source):SessionSnapshot{
 const task=worker(id).task;
 return {session:{id,projectId:'project',title:task.title,workspaceRole:'worker',status:stage>=9?'waiting_approval':'investigating'},messages:[],resources:[],actions:[],terminals:[],evidence:[],cursor:stage,
  superagent:{task},ai:{session:id,profile:'core',usage:{known:false,input:0,output:0,total:0},status:stage===9?'waiting_approval':stage===10?'waiting_input':'running',turnStartedAt:at,cards:cards(),cardsOffset:0,totalCards:cards().length,
   ...(stage===9?{pending:{id:'approval-a',kind:'resource_select',risk:'readonly',target:'虚构服务器',fingerprint:'synthetic',call:{id:'tool',name:'inspect_host',arguments:'{}'}}}:{}),
   ...(stage===10?{question:{id:'question-a',questions:[{id:'scope',title:'这次要检查哪台服务器？',options:[{label:'样例 A'}]}]}}:{})},
  ...(stage===11?{hostKeyTrust:{id:'trust-a',resourceId:'fixture-host',host:'127.0.0.1',port:2222,algorithm:'ssh-ed25519',fingerprint:'SHA256:SYNTHETIC-FIXTURE-ONLY',previousFingerprints:[],changed:false,scope:'lake'}}:{})} as unknown as SessionSnapshot;
}
function page(cursor:string):SpecialistChannelPage{
 const records:SpecialistChannelEntry[]=[{id:'source-user',sourceSessionId:'channel',createdAt:'2026-11-06T07:59:00Z',message:{id:'source-user',sessionId:'channel',role:'user',text:'看看这台服务器现在的情况。',createdAt:'2026-11-06T07:59:00Z'}}];
 if([4,5,6].includes(stage))for(const card of cards().filter(card=>card.type==='message'))records.push({id:channelCardEntryId(source,card.id),sourceSessionId:source,taskId:worker().task.taskId,workerId:worker().id,createdAt:card.at,card});
 if(cursor)records.unshift({id:'older',sourceSessionId:'old-worker',createdAt:'2026-11-05T07:00:00Z',message:{id:'older',sessionId:'old-worker',role:'assistant',text:'这是之前一次检查的独立记录。',createdAt:'2026-11-05T07:00:00Z'}});
 const sources=stage===7?[source,'worker-b']:[source];
 return {channel:{id:'channel-id',projectId:'project',roleId:'role',roleName:'服务器运维专员',sessionId:'channel',revision:1,createdAt:at},entries:records,workers:sources.map(worker),active:[4,5,6].includes(stage)?[]:sources.map(active),routing:false,queued:0,nextCursor:stage===8&&!cursor?'older':''};
}
window.fetch=async(input,init)=>{
 const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href);metrics.requests++;
 if(init?.method&&init.method!=='GET'){metrics.actions.push(url.pathname);return Response.json({ok:true});}
 if(url.pathname.endsWith('/channel'))return Response.json(page(url.searchParams.get('cursor')??''));
 if(url.pathname.endsWith('/snapshot'))return Response.json(active());
 return Response.json({});
};
const snapshot={session:{id:'channel',projectId:'project',title:'服务器运维专员',workspaceRole:'role'},messages:[],resources:[]} as unknown as SessionSnapshot;
function Fixture(){
 const [current,setCurrent]=useState(0),[selected,setSelected]=useState(''),[playing,setPlaying]=useState(false);
 useEffect(()=>{
  const check=()=>{
   const entry=[...document.querySelectorAll('[data-channel-entry]')].find(node=>node.getAttribute('data-channel-entry')===channelCardEntryId(source,'shared-card'))??null;
   const card=entry?.querySelector('.ai-card')??null;
   if(!originalEntry&&entry)originalEntry=entry;else if(entry&&entry!==originalEntry){metrics.sameEntryNode=false;metrics.entryReplacements++;originalEntry=entry;}
   if(!originalCard&&card)originalCard=card;else if(card&&card!==originalCard){metrics.sameCardNode=false;metrics.cardReplacements++;originalCard=card;}
  };
  const observer=new MutationObserver(check);observer.observe(document.getElementById('channel-preview')!,{subtree:true,childList:true});check();return()=>observer.disconnect();
 },[]);
 useEffect(()=>{if(!playing)return;const timer=setInterval(()=>{stage=Math.min(stage+1,4);setCurrent(stage);if(stage===4)setPlaying(false);},1600);return()=>clearInterval(timer);},[playing]);
 return <main style={{height:'100%',overflow:'auto',padding:'20px clamp(12px,4vw,40px)'}}><div style={{maxWidth:900,margin:'0 auto'}}>
  <header style={{display:'flex',gap:6,flexWrap:'wrap',marginBottom:24}}>
   <button onClick={()=>{document.documentElement.dataset.theme=document.documentElement.dataset.theme==='dark'?'light':'dark';}}>切换主题</button>
   <button onClick={()=>setPlaying(true)}>连续播放到完成</button>
   {stages.map((name,index)=><button key={name} aria-pressed={current===index} onClick={()=>{setPlaying(false);stage=index;setCurrent(index);}}>{name}</button>)}
  </header>
  <p data-preview-stage={current}>当前：{stages[current]}。每秒读取本地样例，不调用模型或服务器。</p>
  <section id="channel-preview" className="conversation" style={{height:'auto',padding:0,overflow:'visible'}}><SpecialistChannel snapshot={snapshot} connected onTask={id=>setSelected(id)}/></section>
  <output aria-label="打开的原任务">{selected}</output>
 </div></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
