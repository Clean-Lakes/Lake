// Real transcript, projection, transport subscription and scroll follower.
// All messages and source snapshots are synthetic; no backend request escapes.
import {useLayoutEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import type {AICard,ExternalReplyStage,Message,SessionEvent,SessionSnapshot,SpecialistChannelInfo,SuperWorker,SuperWorkspace} from '../../../shared/contracts';
import {updateExternalReplyStages,type AgentExecutionSummary} from '../../../shared/external-agents';
import {AITranscript} from '../../src/AIPanel';
import {ObjectReferencesProvider} from '../../src/AssistantMarkdown';
import {SpecialistAvatarProvider} from '../../src/SuperRoleAvatar';
import {FollowScroll,followsConversationScroll,observeConversationGrowth,pausesConversationFollow} from '../../src/followScroll';
import '../../src/theme.css';
import '../../src/styles.css';
import '../../src/pilotWorkspace.css';
import '../../src/specialistAvatars.css';
import '../../src/assistantProse.css';
import '../../src/conversationBubbles.css';
import '../../src/sreCollaboration.css';

const at='2026-11-16T08:00:00.000Z',started='2026-11-16T08:00:01.000Z';
const labels=['思考','工具状态','首段进度','流式追加','工具执行','新段进度','最终段待报告','源快照先结束','完成待报告','结束后播报','结束快照空窗','正式报告','ACP晚到累计','ACP完成message','等待审批','活动快照空窗','断线','删除专员'] as const;
type Stage=typeof labels[number];
let stage:Stage='思考',cursor=1,servedCursor=0,acp=true,long=false,secondComplete=false;
let replyStages:ExternalReplyStage[]=[];
const streams=new Set<FixtureEvents>();
class FixtureEvents extends EventTarget {
 readyState=1;onopen:(()=>void)|null=null;onerror:(()=>void)|null=null;onmessage:((event:MessageEvent)=>void)|null=null;
 constructor(){super();streams.add(this);queueMicrotask(()=>this.onopen?.());}
 close(){this.readyState=2;streams.delete(this);}
}
window.EventSource=FixtureEvents as unknown as typeof EventSource;
const primary={kind:'specialist' as const,name:'服务器运维排查专员',roleId:'role-host',workerId:'worker-host',sessionId:'source-host',taskId:'task-host',rootTurnId:'sdk-current',avatarId:'flamingo' as const};
const parallel={...primary,name:'资料核对专员',roleId:'role-library',workerId:'worker-library',sessionId:'source-library',taskId:'task-library',rootTurnId:'sdk-library',avatarId:'owl' as const};
const hasReport=()=>['正式报告','ACP晚到累计','ACP完成message'].includes(stage);
const terminal=()=>hasReport()||['完成待报告','结束后播报','结束快照空窗'].includes(stage);
const first='我先核对公开样例的 CPU 与内存。';
const firstAppend=' 再读取磁盘与进程摘要。';
const shortProgress='已取得样例数据，正在对比本轮变化。';
const longProgress='已取得样例数据，正在逐项核对。\n\n- 负载与内存：使用固定的虚构数字，仅验证排版。\n- 磁盘与进程：继续比对本轮公开摘要。\n- 关联资料：保留 [样例记录](#fixture-evidence) 与 `sample-only`。\n\n'+('这一段仅用于观察长内容替换时的滚动和持续跃动，不表示执行了业务检查。'.repeat(5));
const conclusion='本轮样例核对已结束，未连接业务资源。';
function publicSegment(){
 if(['思考','工具状态'].includes(stage))return {id:'acp_message_first',content:''};
 if(['源快照先结束','结束后播报'].includes(stage))return {id:'acp_message_ending',content:'执行已经结束，正在整理结论。'};
 if(['首段进度','流式追加','工具执行'].includes(stage))return {id:'acp_message_first',content:first+(stage==='首段进度'?'':firstAppend)};
 if(['最终段待报告','完成待报告','正式报告','ACP晚到累计','ACP完成message'].includes(stage))return {id:'acp_message_final',content:conclusion};
 return {id:'acp_message_second',content:long?longProgress:shortProgress};
}
function execution(isSecond=false):AgentExecutionSummary{
 const finished=isSecond?secondComplete:stage==='ACP完成message';
 return {backend:acp&&!isSecond?{kind:'acp',agent:'codex'}:{kind:'native'},source:'task_assignment',assignedAt:started,totalRuns:acp&&!isSecond?1:0,
  runs:acp&&!isSecond?[{id:'acp-run-current',agent:'codex',scope:'worker',state:finished?'completed':'running',dispatchPhase:'sent',createdAt:started,updatedAt:started,usage:null}]:[]};
}
function worker(isSecond=false):SuperWorker{
 const author=isSecond?parallel:primary,finished=isSecond?secondComplete:terminal();
 const absent=!isSecond&&(stage==='活动快照空窗'||terminal());
 const waiting=!isSecond&&stage==='等待审批',tool=isSecond||['工具执行','工具状态'].includes(stage);
 return {id:author.workerId,roleId:author.roleId,roleName:author.name,sessionId:author.sessionId,execution:execution(isSecond),assignmentState:finished?'parked':'active',
  task:{taskId:author.taskId,sessionId:author.sessionId,projectId:'fixture-project',title:isSecond?'并行资料核对':'公开进度连续性验收',state:finished?'completed':waiting?'waiting_user':'running',acceptanceState:finished?'pass':'not_evaluated',revision:1,originRootTurnId:'task-origin',deadlineAt:''},
  activity:absent||finished?undefined:{phase:waiting?'waiting_approval':tool?'tool':'thinking',label:waiting?'等待确认':tool?'正在读取公开样例':'正在分析',sourceSessionId:'pilot-fixture',sourceMessageId:'user-fixture',updatedAt:started}};
}
function sourceCards(isSecond=false):AICard[]{
 if(isSecond)return [{id:'parallel-progress',type:'message',status:secondComplete?'completed':'running',at:started,content:'并行核对资料目录；第一位专员结束后，我仍继续当前任务。',data:{root_turn_id:parallel.rootTurnId}}];
 if(stage==='结束快照空窗')return [];
 const latest=replyStages.filter(item=>item.kind==='prose').at(-1);
 const segment=latest?{id:latest.id,content:latest.content}:publicSegment();
 const cumulative=segment.id==='acp_message_first'?segment.content:[first+firstAppend,long?longProgress:shortProgress,...(segment.id==='acp_message_final'?[conclusion]:[])].join('\n\n');
 const cards:AICard[]=acp?[{id:'acp-run-current',type:'operation',status:stage==='ACP完成message'?'completed':'running',at:started,content:cumulative+(stage==='ACP晚到累计'?'\n\n晚到的累计审计更新，不应替换已送达报告。':''),
  data:{source:'external_agent',external_run_id:'acp-run-current',taskId:primary.taskId,root_turn_id:primary.rootTurnId,external_reply:segment,
   ...(replyStages.length>0&&{external_reply_stages:replyStages})}}]:segment.content?[{id:segment.id,type:'message',status:'running',at:started,content:segment.content,data:{root_turn_id:primary.rootTurnId}}]:[];
 if(['工具执行','工具状态'].includes(stage))cards.push({id:'sample-operation',type:'operation',status:'running',at:started,title:'读取样例',content:'PRIVATE_TOOL_DETAIL',data:{root_turn_id:primary.rootTurnId}});
 if(stage==='ACP完成message')cards.push({id:'acp-completed-message',type:'message',status:'completed',at:'2026-11-16T08:00:12.000Z',content:cumulative,data:{root_turn_id:primary.rootTurnId}});
 return cards;
}
function sourceSnapshot(isSecond=false):SessionSnapshot{
 const owner=worker(isSecond),cards=sourceCards(isSecond),done=isSecond?secondComplete:terminal()||stage==='源快照先结束',waiting=!isSecond&&stage==='等待审批';
 return {session:session(owner.sessionId,'worker'),superagent:{roleId:owner.roleId,task:!isSecond&&stage==='源快照先结束'?{...owner.task,state:'completed'}:owner.task,execution:owner.execution},cursor,messages:[],resources:[],actions:[],specialists:[],evidence:[],terminals:[],
  ai:{session:owner.sessionId,profile:'fixture',turns:1,usage:{input:0,output:0,total:0},status:waiting?'waiting_approval':done?'completed':'running',replyStatus:done?undefined:'running',rootTurnId:isSecond?parallel.rootTurnId:stage==='结束快照空窗'?undefined:primary.rootTurnId,turnStartedAt:started,cards,cardsOffset:0,totalCards:cards.length}};
}
function session(id:string,workspaceRole:'router'|'worker'){return {id,projectId:'fixture-project',workspaceRole,title:'连续进度隔离验收',status:'idle' as const,resourceIds:[],createdAt:at,updatedAt:started};}
window.fetch=async input=>{
 const path=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,window.location.href).pathname;
 if(path===`/api/sessions/${primary.sessionId}/snapshot`){servedCursor=cursor;return Response.json(sourceSnapshot());}
 if(path===`/api/sessions/${parallel.sessionId}/snapshot`)return Response.json(sourceSnapshot(true));
 return Response.json({error:'fixture blocks all other requests'},{status:404});
};
function announce(incremental=false,isSecond=false){
 const card=sourceCards()[0],segment=publicSegment();
 const textUpdate=incremental&&card?{target:'card',id:card.id,content:card.content,cardType:card.type,at:card.at,rootTurnId:primary.rootTurnId,...(acp?{externalReply:segment}:{})}:undefined;
 for(const stream of streams)stream.dispatchEvent(new MessageEvent('session',{data:JSON.stringify({sessionId:isSecond?parallel.sessionId:primary.sessionId,seq:cursor,textUpdate})}));
}
function publishPhase(update:ExternalReplyStage){
 replyStages=updateExternalReplyStages(replyStages,update);
 const card=sourceCards()[0]!;
 const textUpdate:SessionEvent['textUpdate']=update.kind==='prose'?{target:'card',id:card.id,content:card.content??'',cardType:'operation',rootTurnId:primary.rootTurnId,externalReply:{id:update.id,content:update.content}}:undefined;
 const event={sessionId:primary.sessionId,seq:++cursor,textUpdate,externalReplyStageUpdate:{id:card.id,taskId:primary.taskId,rootTurnId:primary.rootTurnId,
  stage:update.kind==='prose'?{kind:update.kind,id:update.id}:update}};
 for(const stream of streams)stream.dispatchEvent(new MessageEvent('session',{data:JSON.stringify(event)}));
}
const user:Message={id:'user-fixture',sessionId:'pilot-fixture',role:'user',text:'检查隔离样例的进度更新。',createdAt:at};
const history:Message[]=Array.from({length:4},(_,index)=>[
 {id:`history-user-${index}`,sessionId:user.sessionId,role:'user' as const,text:`历史问题 ${index+1}：保留原有节点。`,createdAt:`2026-11-16T07:${10+index*2}:00.000Z`},
 {id:`history-reply-${index}`,sessionId:user.sessionId,role:'assistant' as const,text:`历史记录 ${index+1}。此段在后续进度与报告更新时应保持原节点。\n\n[历史链接 ${index+1}](#history-evidence-${index})\n\n| 样例 | 状态 |\n| --- | --- |\n| 固定记录 | 已确认 |`,createdAt:`2026-11-16T07:${11+index*2}:00.000Z`},
]).flat();
const channels:SpecialistChannelInfo[]=[primary,parallel].map(author=>({id:`channel-${author.workerId}`,roleId:author.roleId,roleName:author.name,avatarId:author.avatarId,sessionId:`channel-${author.sessionId}`,projectId:'fixture-project',revision:1,createdAt:at}));
type Nodes={slot:Element|null;identity:Element|null;body:Element|null;prose:Element|null;history:Element[];parallel:Element|null;top:number};
function Fixture(){
 const [current,setCurrent]=useState(stage),[revision,setRevision]=useState(0),[later,setLater]=useState(false),[parallelOn,setParallelOn]=useState(true),[mode,setMode]=useState(acp),[expanded,setExpanded]=useState(long),[opened,setOpened]=useState(''),[qa,setQA]=useState('尚未捕获基线');
 const box=useRef<HTMLDivElement>(null),follower=useRef<FollowScroll|null>(null),following=useRef(true),baseline=useRef<Nodes|null>(null),scrolls=useRef(0);
 const nodes=():Nodes=>{
  const root=box.current!,slot=root.querySelector(`[data-worker-id="${primary.workerId}"]`);
  const old=[...root.querySelectorAll('.ai-turn')].slice(0,4);
  return {slot,identity:slot?.querySelector('.response-identity')??null,body:slot?.querySelector('.pilot-specialist-reply-content')??null,prose:slot?.querySelector('.ai-message')??null,history:old.flatMap(node=>[node,...node.querySelectorAll('p,a,table')]),parallel:root.querySelector(`[data-worker-id="${parallel.workerId}"]`),top:root.scrollTop};
 };
 const measure=()=>{
  const now=nodes(),before=baseline.current;
  return {stage,cursor,servedCursor,mode:acp?'ACP':'Native',captured:!!before,slotSame:!!before?.slot&&before.slot===now.slot,identitySame:!!before?.identity&&before.identity===now.identity,bodySame:!!before?.body&&before.body===now.body,proseSame:!!before?.prose&&before.prose===now.prose,
   historyNodes:now.history.length,historySame:!!before?.history.length&&before.history.length===now.history.length&&before.history.every((node,index)=>node.isConnected&&node===now.history[index]),parallelSame:!!before?.parallel&&before.parallel===now.parallel,
   endingNotice:now.slot?.querySelector('.pilot-specialist-connection')?.textContent??'',bodyHeight:now.body?.getBoundingClientRect().height??0,bodyAnimations:now.body?.getAnimations().map(animation=>({playState:animation.playState,duration:animation.effect?.getTiming().duration}))??[],
   following:following.current,scrollTop:now.top,scrollDelta:before?now.top-before.top:0,scrollEvents:scrolls.current,scrollHeight:box.current!.scrollHeight,clientHeight:box.current!.clientHeight,reportId:now.slot?.getAttribute('data-report-id')??'',publicText:now.body?.textContent??''};
 };
 const capture=()=>{baseline.current=nodes();scrolls.current=0;const result=measure();setQA(JSON.stringify(result));return result;};
 const inspect=()=>{const result=measure();setQA(JSON.stringify(result));return result;};
 useLayoutEffect(()=>{
  const container=box.current!,scroll=new FollowScroll(container,()=>following.current,undefined,window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  follower.current=scroll;scroll.jump();
  const stop=observeConversationGrowth(container,()=>scroll.request());
  Object.assign(window,{specialistProgressQA:{capture,measure,publishPhase}});
  return()=>{stop();scroll.stop();delete (window as unknown as {specialistProgressQA?:unknown}).specialistProgressQA;};
 },[]);
 const move=(next:Stage)=>{stage=next;cursor++;setCurrent(next);setRevision(value=>value+1);announce(next==='流式追加');};
 const refresh=()=>{cursor++;setRevision(value=>value+1);announce();};
 const workspace:SuperWorkspace={active:true,project:{projectId:'fixture-project',routerSessionId:user.sessionId,version:1},workers:[...(stage==='删除专员'?[]:[worker()]),...(parallelOn?[worker(true)]:[])],channels};
 const report:Message={id:'report-current',sessionId:user.sessionId,role:'assistant',text:conclusion,createdAt:'2026-11-16T08:00:09.000Z',author:{...primary,execution:execution().backend}};
 const snapshot:SessionSnapshot={session:session(user.sessionId,'router'),cursor,messages:[...history,user,{id:'pilot-arranged',sessionId:user.sessionId,role:'assistant',text:'已安排两位专员核对隔离样例。',createdAt:started},
  ...(later?[{id:'later-user',sessionId:user.sessionId,role:'user' as const,text:'另一件事：保留先前任务的位置，稍后再处理这条。',createdAt:'2026-11-16T08:00:08.000Z'}]:[]),...(hasReport()?[report]:[])],resources:[],actions:[],specialists:[],evidence:[],terminals:[],
  ai:{session:user.sessionId,profile:'fixture',turns:1,usage:{input:0,output:0,total:0},status:'completed',cards:[],cardsOffset:0,totalCards:0}};
 return <main style={{maxWidth:1040,margin:'20px auto',padding:'0 16px'}}>
  <header style={{display:'flex',gap:8,flexWrap:'wrap'}}>{labels.map(label=><button key={label} aria-pressed={current===label} onClick={()=>move(label)}>{label}</button>)}</header>
  <div style={{display:'flex',gap:8,flexWrap:'wrap',marginTop:10}}>
   <button aria-pressed={mode} onClick={()=>{acp=!acp;setMode(acp);baseline.current=null;move('思考');}}>{mode?'ACP operation':'Native message'}</button>
   <button aria-pressed={expanded} onClick={()=>{long=!long;setExpanded(long);move('新段进度');}}>{expanded?'换成短段':'换成长段'}</button>
   <button aria-pressed={later} onClick={()=>{setLater(value=>!value);refresh();}}>后续用户消息</button>
   <button aria-pressed={parallelOn} onClick={()=>setParallelOn(value=>!value)}>第二专员并行</button>
   <button onClick={()=>{secondComplete=!secondComplete;cursor++;setRevision(value=>value+1);announce(false,true);}}>切换第二专员完成</button>
   <button onClick={refresh}>无关快照</button>
   <button onClick={()=>{document.documentElement.dataset.theme=document.documentElement.dataset.theme==='dark'?'light':'dark';}}>切换主题</button>
  </div>
  <p data-stage={current}>当前：{current} · 快照 {revision} · 仅使用虚构本地数据。按首段→工具→新段→最终段→报告→晚到累计/完成验证。</p>
  <div style={{display:'flex',gap:8,flexWrap:'wrap',marginBottom:12}}>
   <button onClick={capture}>捕获 DOM 基线</button><button onClick={inspect}>检查节点与滚动</button>
   <button onClick={()=>{following.current=false;follower.current?.stop();box.current!.scrollTop=180;}}>阅读历史</button>
   <button onClick={()=>{following.current=true;follower.current?.jump();}}>跟随最新</button>
  </div>
  <output data-testid="continuity-qa" style={{display:'block',fontSize:12,overflowWrap:'anywhere',maxHeight:88,overflow:'auto',marginBottom:12}}>{qa}</output>
  {opened&&<p data-opened-worker={opened}>已打开对应专员入口：{opened}</p>}
  <div ref={box} className="conversation" tabIndex={0} style={{height:520,flex:'none',overflow:'auto',overflowAnchor:'none',border:'1px solid var(--border)',padding:'20px 16px'}}
   onWheel={event=>{if(pausesConversationFollow(box.current!,event.deltaY,following.current)){following.current=false;follower.current?.stop();}}}
   onKeyDown={event=>{if(['ArrowUp','PageUp','Home'].includes(event.key)){following.current=false;follower.current?.stop();}}}
   onScroll={()=>{scrolls.current++;following.current=followsConversationScroll(box.current!,following.current);}}>
   <SpecialistAvatarProvider channels={channels}><ObjectReferencesProvider><AITranscript snapshot={snapshot} pilotWorkspace={workspace} pilotConnected={stage!=='断线'} assistantIdentity={{name:'Pilot',pilot:true}} onSpecialist={author=>setOpened(author.workerId)} onInspectSpecialist={author=>setOpened(author.workerId)}/></ObjectReferencesProvider></SpecialistAvatarProvider>
  </div>
  <details style={{marginTop:12}}><summary>查看当前合成源事件</summary><pre style={{fontSize:11,whiteSpace:'pre-wrap'}}>{JSON.stringify({cards:sourceCards(),worker:worker()},null,2)}</pre></details>
 </main>;
}
document.documentElement.dataset.theme='light';
createRoot(document.getElementById('root')!).render(<Fixture/>);
