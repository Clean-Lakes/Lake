// Actual App, isolated in-memory transport. All writes stay in this fixture.
import './readme-workbench';
import type {Message,SessionSnapshot,SuperWorkspace} from '../../../shared/contracts';
const inherited=window.fetch.bind(window),session='demo-session-0',project='demo-project';
const at=(second:number)=>`2026-11-16T08:00:${String(second).padStart(2,'0')}.000Z`;
const accepted:Message[]=[{id:'continuous-a',sessionId:session,role:'user',text:'A：请核对本地样例。',createdAt:at(0)}];
const payloads:Record<string,unknown>[]=[],streams=new Set<InputEvents>();
let cursor=10,stopCalls=0,stage:'A'|'B'='A';
let baseline:{turn:Element|null;body:Element|null;input:Element|null}|undefined;
const workspace:SuperWorkspace={active:true,project:{projectId:project,routerSessionId:session,version:1},workers:[],channels:[],cursor};
const emit=()=>{cursor++;for(const stream of streams)stream.onmessage?.(new MessageEvent('message',{data:JSON.stringify({sessionId:session,type:'session',seq:cursor})}));};
class InputEvents extends EventTarget{
 static CONNECTING=0;static OPEN=1;static CLOSED=2;readyState=1;
 onopen:((event:Event)=>void)|null=null;onmessage:((event:MessageEvent<string>)=>void)|null=null;onerror=null;
 constructor(..._args:unknown[]){super();streams.add(this);queueMicrotask(()=>this.onopen?.(new Event('open')));}
 close(){this.readyState=2;streams.delete(this);}
}
window.EventSource=InputEvents as unknown as typeof EventSource;
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
window.fetch=async(input,init)=>{
 const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href);
 const method=init?.method??'GET';
 if(url.pathname.endsWith('/messages')&&method==='POST'){
  const payload=JSON.parse(String(init?.body));payloads.push(payload);
  if(payload.enqueue===true)return json({error:'Pilot should admit rather than queue this message'},409);
  const message:Message={id:'continuous-'+String.fromCharCode(97+accepted.length),sessionId:session,role:'user',text:payload.text,createdAt:at(accepted.length*2)};
  accepted.push(message);emit();return json({...message,pilotSessionId:session},202);
 }
 if(method!=='GET'&&url.pathname.startsWith('/api/')){
  if(url.pathname.includes('stop')||url.pathname.includes('abort'))stopCalls++;
  return json({error:'Unrequested fixture write'},405);
 }
 if(url.pathname===`/api/projects/${project}/superagent`)return json(workspace);
 const response=await inherited(input,init);
 if(url.pathname==='/api/bootstrap')return json({...await response.json(),backendRuntime:'typescript',aiRuntime:'sdk'});
 if(url.pathname==='/api/catalog'){
  const value=await response.json();value.sessions=value.sessions.map((s:{id:string})=>s.id===session?{...s,workspaceRole:'router',status:'investigating',title:'Pilot'}:s);return json(value);
 }
 if(url.pathname.endsWith('/snapshot')){
  const value:SessionSnapshot=await response.json();value.session={...value.session,id:session,projectId:project,workspaceRole:'router',title:'Pilot',status:'investigating'};
  value.messages=[...accepted];value.cursor=cursor;value.sre=undefined;value.actions=[];value.replyTimings=[];value.terminals=[];
  value.messageQueue={pushSupported:false,paused:true,revision:1,lastError:'',items:[{id:'old-draft',text:'保留的旧草稿',resourceIds:[],images:[],files:[],createdAt:at(0)}]};
  value.ai={...value.ai!,session,status:'running',replyStatus:'running',rootTurnId:'root-'+stage.toLowerCase(),sourceMessageIds:[stage==='A'?'continuous-a':'continuous-b'],turnStartedAt:at(stage==='A'?1:5),pending:undefined,pendingApprovals:[],question:undefined,agentRuns:[],cardsOffset:0,totalCards:stage==='A'?1:2,
   cards:[{id:'reply-a',type:'message',content:'A 的公开进度保持在原消息下方，新的要求可以继续发送。',status:stage==='A'?'running':'completed',at:at(1),data:{root_turn_id:'root-a',source_message_id:'continuous-a'}},
    ...(stage==='B'?[{id:'reply-b',type:'message',content:'B 已作为独立消息接入，正在区分新任务和原任务补充。',status:'running',at:at(5),data:{root_turn_id:'root-b',source_message_id:'continuous-b'}}]:[])]};
  return json(value);
 }
 return response;
};
const measure=()=>{
 const turn=[...document.querySelectorAll('.ai-turn')].find(el=>el.textContent?.includes('A：请核对本地样例。'))??null;
 return {accepted:accepted.map(m=>({id:m.id,text:m.text})),payloads,stopCalls,stage,
  originalTurnRetained:!baseline||baseline.turn===turn,originalBodyRetained:!baseline||baseline.body===turn?.querySelector('.ai-message'),inputRetained:!baseline||baseline.input===document.getElementById('message-input'),
  originalReplyCount:[...document.querySelectorAll('.ai-message')].filter(el=>el.textContent?.includes('A 的公开进度')).length,
  queueCopies:document.querySelectorAll('.pending-message').length,overflow:document.documentElement.scrollWidth>innerWidth};
};
Object.assign(window,{pilotContinuousQA:{measure,capture(){const turn=[...document.querySelectorAll('.ai-turn')].find(el=>el.textContent?.includes('A：请核对本地样例。'))??null;baseline={turn,body:turn?.querySelector('.ai-message')??null,input:document.getElementById('message-input')};return measure();},advance(){stage='B';emit();}}});
