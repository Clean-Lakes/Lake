// Full-App regression with fictional history and in-memory SSE; no model/host calls.
import {createRoot} from 'react-dom/client';
import App from '../../src/App';
import type {SessionSnapshot,AICard} from '../../../shared/contracts';
import {setThemePreference} from '../../src/appearance';
import '../../src/theme.css';
import '../../src/styles.css';
import '../../src/assistantProse.css';
import '../../src/appSelect.css';
import '../../src/composerModelSelect.css';
import '../../src/providerIcon.css';
import '../../src/composerCompletion.css';
import '../../src/agentQuestion.css';
const query=new URLSearchParams(location.search);
setThemePreference(query.get('theme')==='dark'?'dark':'light');
const stamp=(index:number)=>new Date(Date.now()-3600000+index*1000).toISOString();
const messages=Array.from({length:12},(_,i)=>({id:`user-${i}`,sessionId:'fixture',role:'user',text:i===11?'核对演示服务状态':`历史检查 ${i+1}`,createdAt:stamp(i*10)}));
const cards:AICard[]=Array.from({length:11},(_,i)=>({id:`reply-${i}`,type:'message',status:'completed',at:stamp(i*10+1),content:'历史检查记录保持稳定。\n\n| 项目 | 观察 |\n| --- | --- |\n| 演示服务 | 正常 |\n\n[查看已保存证据](#evidence)'}));
cards.push({id:'note',type:'message',status:'completed',at:stamp(111),content:'先核对演示服务与运行记录，保留本轮原始证据。'},{id:'operation-0',type:'operation',title:'shell',status:'running',at:stamp(112),content:'',data:{target:'演示主机',arguments:{command:'uptime'}}});
if(query.has('space')){messages.splice(0,11);cards.splice(0,11)}
if(query.has('narration-only'))cards.pop();
if(query.has('progress-only'))cards.find(card=>card.id==='note')!.content='';
if(query.has('families')){cards.find(card=>card.id==='operation-0')!.title='list_workflows';cards.find(card=>card.id==='operation-0')!.data={target:'当前项目/会话',arguments:{}}}
cards.push({id:'empty-thought',type:'thinking',status:query.has('reasoning')?'completed':'running',at:stamp(query.has('reasoning')?111.5:110.5),content:query.has('reasoning')?'先核对演示主机的实际状态。':''});
const state={session:{id:'fixture',projectId:'p',title:'进度更新稳定性',status:'investigating',createdAt:stamp(0),updatedAt:stamp(0),tags:[]},cursor:1,messages,resources:[],resourceTree:[],specialists:[],evidence:[],actions:[],terminals:[],ai:{session:'fixture',status:'running',rootTurnId:'turn',turnStartedAt:new Date().toISOString(),cards,cardsOffset:0,totalCards:cards.length,turns:12,usage:{input:0,output:0,total:0}},messageQueue:{paused:false,revision:0,lastError:'',items:[]},sre:{enabled:false,tasks:[]}} as unknown as SessionSnapshot;
if(query.has('reference-time')){
 const user=state.messages.at(-1)!;
 const stopped=query.has('stopped');
 state.replyTimings=[{messageId:user.id,startedAt:user.createdAt,finishedAt:new Date(Date.parse(user.createdAt)+(stopped?36000:594000)).toISOString(),status:stopped?'cancelled':'completed'}];
 state.session.status='completed';state.ai!.status=stopped?'cancelled':'completed';
 state.ai!.cards.forEach(card=>{if(card.status==='running')card.status='completed'});
 if(stopped){
  const operation=state.ai!.cards.find(card=>card.id==='operation-0')!;
  operation.status='failed';operation.content='演示操作失败，原始输出保留。';
  state.ai!.cards.push({...operation,id:'operation-failed-1',at:stamp(113)});
 }
 state.ai!.cards.push({id:'reference-answer',type:'message',status:'completed',at:stamp(114),content:'已核对演示服务的运行状态，完整执行步骤与命令结果可在上方用时入口中查看。'});
}
const lineArrivals:{kind:string;duration:number|undefined}[]=[];
const motionSamples:{kind:string;y:number;opacity:number}[]=[];
const metrics={executionName:"",executionPhase:"",statusTop:0,statusHeight:0,statusBeforeReply:false,executionAnimations:0,rowReplacements:0,rowRemovals:0,rowPositionChanges:0,rowColorChanges:0,renderedRows:[] as {id:string;kind:string;top:number}[],lineArrivals,motionSamples,snapshots:0,subscriptions:0,actionReplacements:0,historyReplacements:0,actionAnimations:0,replyAnimations:0,replyReplacements:0,scrollWrites:0,scrollEvents:0,scrollChanges:0,heightChanges:0,updates:0,errors:0,top:0,height:0};
const streams=new Set<FixtureStream>();
class FixtureStream extends EventTarget {
 static OPEN=1;readyState=1;onopen:((event:Event)=>void)|null=null;onerror=null;onmessage=null;
 constructor(){super();streams.add(this);metrics.subscriptions++;queueMicrotask(()=>this.onopen?.(new Event('open')))}
 close(){this.readyState=2;streams.delete(this)}
 emit(){this.dispatchEvent(new MessageEvent('session',{data:JSON.stringify({sessionId:'fixture',seq:state.cursor,type:'session'})}))}
}
window.EventSource=FixtureStream as unknown as typeof EventSource;
window.fetch=async(input)=>{
 const path=new URL(String(input),location.href).pathname;let value:unknown={};
 if(path==='/api/bootstrap')value={authenticated:true,modelConfigured:true,modelName:'演示模型',modelId:'fixture',aiRuntime:'adk',terminalMode:'pty'};
 else if(path==='/api/catalog')value={projects:[{id:'p',name:'隔离测试',createdAt:stamp(0)}],sessions:[state.session],resources:[],resourceTree:[],tags:[],terminals:[]};
 else if(path.endsWith('/snapshot')){metrics.snapshots++;value=state}
 else if(path.includes('/reasoning'))value={levels:[],effort:'',modelId:'fixture'};
 else if(path.endsWith('/message-queue'))value=state.messageQueue;
 else if(path.includes('/skills'))value={skills:[],roots:[]};
 else if(path.includes('/mcp'))value={servers:[]};
 else if(path.includes('/presets')||path.includes('/references')||path.endsWith('/available'))value=[];
 return new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
};
const nativeAnimate=Element.prototype.animate;
Element.prototype.animate=function(keyframes,options){
 const kind=this.parentElement?.classList.contains('conversation-progress-action')?'action':this.parentElement?.classList.contains('conversation-progress-narration')?'narration':'';
 if(kind)lineArrivals.push({kind,duration:typeof options==='object'?Number(options.duration):options});
 return nativeAnimate.call(this,keyframes,options);
};
const descriptor=Object.getOwnPropertyDescriptor(Element.prototype,'scrollTop')!;
Object.defineProperty(Element.prototype,'scrollTop',{...descriptor,get:descriptor.get,set(value:number){if(this.classList.contains('conversation'))metrics.scrollWrites++;descriptor.set!.call(this,value)}});
document.addEventListener('animationstart',event=>{if((event.target as Element).matches('.conversation-progress-action > span'))metrics.actionAnimations++});
document.addEventListener('animationstart',event=>{if((event as AnimationEvent).animationName==='execution-text-sweep')metrics.executionAnimations++;if((event as AnimationEvent).animationName==='reply-arrival'){metrics.replyAnimations++;const row=event.target as HTMLElement;lineArrivals.push({kind:row.querySelector('.thinking-timeline')?'action':'reply',duration:360})}});
document.addEventListener('scroll',event=>{if((event.target as Element).classList?.contains('conversation'))metrics.scrollEvents++},true);
window.addEventListener('error',()=>metrics.errors++);
createRoot(document.getElementById('root')!).render(<App/>);
const previousRows=new Map<string,{node:HTMLElement;top:number;color:string}>();
let oldAction:Element|null=null,oldTable:Element|null=null,oldReply:Element|null=null,previousTop:number|undefined,previousHeight:number|undefined;
const motionNodes=new WeakMap<Element,number>(),motionAnimations=new WeakMap<Animation,number>();
let motionNodeId=0,motionAnimationId=0;
function readMotion(selector:string){return [...document.querySelectorAll(selector)].map(node=>{
 if(!motionNodes.has(node))motionNodes.set(node,++motionNodeId);
 const style=getComputedStyle(node);
 return {nodeId:motionNodes.get(node),text:node.textContent,name:style.animationName,phase:style.backgroundPosition,fill:style.webkitTextFillColor,animations:node.getAnimations().map(animation=>{
  if(!motionAnimations.has(animation))motionAnimations.set(animation,++motionAnimationId);
  return {id:motionAnimations.get(animation),state:animation.playState,start:animation.startTime,time:animation.currentTime};
 })};
})}
function measure(){
 const label=document.querySelector('.thinking-label'),status=document.querySelector('.ai-turn:last-child > .turn-status'),reply=document.querySelector('.ai-turn:last-child [data-conversation-entry]');
 if(label){const style=getComputedStyle(label);metrics.executionName=style.animationName;metrics.executionPhase=style.backgroundPosition;}
 if(status){metrics.statusTop=status.getBoundingClientRect().top;metrics.statusHeight=status.getBoundingClientRect().height;metrics.statusBeforeReply=!!reply&&metrics.statusTop<reply.getBoundingClientRect().top;}

 const action=document.querySelector('.conversation-progress-action > span'),table=document.querySelector('.assistant-prose table'),conversation=document.querySelector<HTMLElement>('.conversation');
 for(const node of document.querySelectorAll('.reply-arrival')){const kind=node.querySelector('.thinking-timeline')?'action':'reply';
  if(node?.getAnimations().some(a=>a.playState==='running')&&motionSamples.length<120){const style=getComputedStyle(node);motionSamples.push({kind,y:new DOMMatrixReadOnly(style.transform).m42,opacity:Number(style.opacity)})}
 }
 const viewport=document.querySelector<HTMLElement>('.conversation');
 const rows=[...document.querySelectorAll<HTMLElement>('.ai-turn:last-child [data-conversation-entry]')];
 const ids=new Set(rows.map(row=>row.dataset.conversationEntry!));
 for(const id of previousRows.keys()){if(!ids.has(id)){metrics.rowRemovals++;previousRows.delete(id)}}
 metrics.renderedRows=[];
 for(const row of rows){
  const id=row.dataset.conversationEntry!,target=row.querySelector('.assistant-prose,.thinking-toggle')??row;
  const top=row.getBoundingClientRect().top-(viewport?.getBoundingClientRect().top??0)+(viewport?.scrollTop??0);
  const color=getComputedStyle(target).color,previous=previousRows.get(id);
  metrics.renderedRows.push({id,kind:row.querySelector('.thinking-timeline')?'operation':'reply',top});
  if(previous){if(previous.node!==row)metrics.rowReplacements++;if(Math.abs(previous.top-top)>.1)metrics.rowPositionChanges++;if(previous.color!==color)metrics.rowColorChanges++}
  if(!row.getAnimations().some(a=>a.playState==='running'))previousRows.set(id,{node:row,top,color});
 }
 if(oldAction&&action!==oldAction)metrics.actionReplacements++;
 if(oldTable&&table!==oldTable)metrics.historyReplacements++;
 oldAction=action;oldTable=table;
 const firstArrival=document.querySelector('.reply-arrival');
 if(oldReply&&oldReply!==firstArrival)metrics.replyReplacements++;
 oldReply=firstArrival;
 if(conversation){
  if(previousTop!==undefined&&conversation.scrollTop!==previousTop)metrics.scrollChanges++;
  if(previousHeight!==undefined&&conversation.scrollHeight!==previousHeight)metrics.heightChanges++;
  metrics.top=previousTop=conversation.scrollTop;metrics.height=previousHeight=conversation.scrollHeight;
 }
 Object.assign(metrics,{textMotion:{reduced:matchMedia('(prefers-reduced-motion: reduce)').matches,status:readMotion('.turn-status .status-text'),rows:readMotion('.thinking-label')}});
 document.getElementById('progress-refresh-metrics')!.textContent=JSON.stringify(metrics);requestAnimationFrame(measure);
}
requestAnimationFrame(measure);
const finishCurrent=()=>state.ai!.cards.filter(card=>card.type!=='thinking'&&card.status==='running').forEach(card=>card.status='completed');
const update=()=>{
 state.cursor++;state.ai!.totalCards=state.ai!.cardsOffset+state.ai!.cards.length;
 // Reproduce the backend's rolling 300-card page with a smaller fixture page.
 if(query.has('rolling')&&state.ai!.cards.length>14){const drop=state.ai!.cards.length-14;state.ai!.cards.splice(0,drop);state.ai!.cardsOffset+=drop;}
 metrics.updates++;streams.forEach(stream=>stream.emit());
};
let index=0,tick=112;
document.getElementById('reset-metrics')!.onclick=()=>{lineArrivals.length=motionSamples.length=0;metrics.executionAnimations=metrics.rowReplacements=metrics.rowRemovals=metrics.rowPositionChanges=metrics.rowColorChanges=0;metrics.actionReplacements=metrics.historyReplacements=metrics.actionAnimations=metrics.replyAnimations=metrics.replyReplacements=metrics.scrollWrites=metrics.scrollEvents=metrics.scrollChanges=metrics.heightChanges=metrics.updates=0};
document.getElementById('update-line')!.onclick=()=>{state.ai!.cards.find(card=>card.id==='note')!.content=`第 ${++index} 次核对演示服务与运行记录，保留本轮原始证据。`;update()};
document.getElementById('finish-tool')!.onclick=()=>{state.ai!.cards.filter(card=>card.type==='operation'||card.type==='shell').forEach(card=>{if(card.status==='running')card.status='completed'});update()};
document.getElementById('fail-tool')!.onclick=()=>{const tool=state.ai!.cards.filter(card=>card.type==='operation'||card.type==='shell').at(-1)!;tool.status='failed';tool.content='演示失败：原始错误记录保留';update()};
document.getElementById('next-reasoning')!.onclick=()=>{state.ai!.cards.filter(card=>card.type==='thinking'||card.type==='operation'||card.type==='shell').forEach(card=>{if(card.status==='running')card.status='completed'});state.ai!.cards.push({id:`reasoning-${++tick}`,type:'thinking',status:'running',at:stamp(tick),content:'继续比对演示主机的进程与连接，保留原始思考记录。'});update()};
document.getElementById('next-operation')!.onclick=()=>{
 state.ai!.cards.filter(card=>card.type==='thinking').forEach(card=>card.status='completed');finishCurrent();
 const n=++index,titles=['list_workflows','save_workflow','schedule_create','schedule_list'];
 const step=query.has('latest-step')?[
  {title:'read',arguments:{path:'/reports/service.log'}},
  {title:'execute_sql',arguments:{sql:'SELECT 1'}},
  {title:'shell',arguments:{command:'ps -ef'}},
 ][(n-1)%3]:undefined;
 state.ai!.cards.push({id:`operation-${n}`,type:'operation',title:step?.title??(query.has('families')?titles[Math.min(n,3)]!:'shell'),status:'running',at:stamp(++tick),content:'',data:query.has('families')?{target:'当前项目/会话',arguments:{}}:{target:query.has('mixed-resources')?(n%2?'演示主机 B':'演示主机'):query.has('same-resource')?'演示主机':`演示主机 ${n}`,arguments:step?.arguments??{command:'uptime'}}});update();
};
document.getElementById('grow-reply')!.onclick=()=>{finishCurrent();state.ai!.cards.push({id:'final-reply',type:'message',status:'completed',at:stamp(++tick),content:'核对完成。\n\n'+('这里是实际新增的回复正文，新增高度应正常跟随到底部。\n\n').repeat(12)});state.ai!.status='completed';state.ai!.turnFinishedAt=new Date().toISOString();update()};
document.getElementById('stream-reply')!.onclick=()=>{finishCurrent();state.ai!.cards.push({id:'stream-reply',type:'message',status:'running',at:stamp(++tick),content:query.has('long')?'核对已完成，完整说明保持可见。\n\n## 详细运行记录\n\n'+('新生成的内容保持原有位置，完成时继续完整展示。\n\n').repeat(40):'核对完成。演示服务运行正常，原始操作记录已保留。'});update()};
document.getElementById('complete-reply')!.onclick=()=>{finishCurrent();state.ai!.status='completed';state.ai!.turnFinishedAt=new Date().toISOString();update()};

document.getElementById('new-narration')!.onclick=()=>{finishCurrent();const n=++index;state.ai!.cards.push({id:`new-note-${n}`,type:'message',status:'completed',at:stamp(++tick),content:'继续核对演示服务的运行记录，保留现有证据。'},{id:`operation-${n}`,type:'operation',title:'shell',status:'running',at:stamp(++tick),content:'',data:{target:'演示主机',arguments:{command:'uptime'}}});update()};

document.getElementById('hide-fixture-controls')!.onclick=()=>{(document.querySelector('.fixture-controls') as HTMLElement).style.display='none'};
