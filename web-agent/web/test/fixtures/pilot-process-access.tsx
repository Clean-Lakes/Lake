// Real transcript, inspector and native worker tree; all transport data is synthetic.
import {useLayoutEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import type {AICard,Message,SessionSnapshot,SpecialistReplyAuthor,SuperWorker,SuperWorkspace,WorkSession} from '../../../shared/contracts';
import {AITranscript} from '../../src/AIPanel';
import {SessionInspector} from '../../src/SessionInspector';
import {SessionInspectorProvider,useSessionInspector} from '../../src/SessionInspectorContext';
import {SpecialistAvatarProvider} from '../../src/SuperRoleAvatar';
import {matchesSpecialistInspection,specialistInspectionWorker,workerInspectionTarget} from '../../src/specialistInspection';
import {initializeFocusModality} from '../../src/focusModality';
import '../../src/theme.css';
import '../../src/styles.css';
import '../../src/pilotWorkspace.css';
import '../../src/specialistAvatars.css';
import '../../src/assistantProse.css';
import '../../src/conversationBubbles.css';
import '../../src/sreCollaboration.css';
import '../../src/sessionInspector.css';
import '../../src/externalAgents.css';
import '../../src/providerIcon.css';

initializeFocusModality();
const at='2026-11-16T08:00:00.000Z',started='2026-11-16T08:00:01.000Z';
const projectId='process-fixture',routerId='pilot-process-fixture',sourceId='native-process-fixture';
const author:SpecialistReplyAuthor={kind:'specialist',name:'服务器运维排查专员',roleId:'role-host',workerId:'worker-host',sessionId:sourceId,taskId:'task-host',rootTurnId:'sdk-native-current',avatarId:'otter'};
const stages={live:'实时进度',long:'大段进度',append:'追加进度',waiting:'等待确认',disconnected:'连接断开',report:'正式报告',restored:'恢复历史'} as const;
type Stage=keyof typeof stages;
let stage:Stage=new URLSearchParams(location.search).get('stage')==='restored'?'restored':'live',cursor=1;
const progress='已取得本地样例，正在核对 CPU 与内存。';
const appended=' 接下来比对磁盘记录。';
const longProgress=progress+'\n\n'+('这段是公开检查进度的本地样例，用来观察长段正文是否保持静止，以及下方过程入口是否继续提示执行状态。'.repeat(5))+'\n\n正在整理各项记录，稍后给出最终结论。';
const conclusion='本轮样例核对完成，三项记录一致。';
const streams=new Set<FixtureEvents>();
class FixtureEvents extends EventTarget{
 readyState=1;onopen:(()=>void)|null=null;onerror:(()=>void)|null=null;onmessage:((event:MessageEvent)=>void)|null=null;
 constructor(){super();streams.add(this);queueMicrotask(()=>this.onopen?.());}
 close(){this.readyState=2;streams.delete(this);}
}
window.EventSource=FixtureEvents as unknown as typeof EventSource;
const finished=()=>stage==='report'||stage==='restored';
function session(id:string,workspaceRole:'router'|'worker'):WorkSession{
 return {id,projectId,workspaceRole,title:'过程入口隔离验收',status:'idle',resourceIds:[],createdAt:at,updatedAt:started};
}
function worker():SuperWorker{
 return {id:author.workerId!,roleId:author.roleId!,roleName:author.name,sessionId:sourceId,assignmentState:finished()?'parked':'active',
  execution:{backend:{kind:'native'},source:'task_assignment',assignedAt:started,totalRuns:0,runs:[]},
  task:{taskId:author.taskId!,sessionId:sourceId,projectId,title:'样例主机检查',state:finished()?'completed':stage==='waiting'?'waiting_user':'running',acceptanceState:finished()?'pass':'not_evaluated',revision:1,originRootTurnId:'task-origin',deadlineAt:'',summary:finished()?conclusion:undefined},
  activity:finished()?undefined:{phase:stage==='waiting'?'waiting_approval':'thinking',label:stage==='waiting'?'等待确认':'正在核对样例',sourceSessionId:routerId,sourceMessageId:'current-user',updatedAt:started}};
}
function nativeCards():AICard[]{
 const current={taskId:author.taskId,root_turn_id:author.rootTurnId};
 const older={taskId:author.taskId,root_turn_id:'sdk-native-previous'};
 return [
  {id:'native-old-thought',type:'thinking',status:'completed',at:'2026-11-16T07:59:00.000Z',content:'上一次尝试先核对样例来源。',data:older},
  {id:'native-old-public',type:'message',status:'completed',at:'2026-11-16T07:59:01.000Z',content:'上一次公开进度：已确认样例目录。',data:older},
  {id:'native-thought',type:'thinking',status:'completed',at:started,content:'专员思考样例：分别比对三项记录，保留每次读取结果。',data:current},
  {id:'native-public',type:'message',status:'completed',at:'2026-11-16T08:00:02.000Z',content:stage==='long'?longProgress:progress+(stage!=='live'?appended:''),data:current},
  {id:'native-tool',type:'operation',title:'inspect_host',status:'completed',at:'2026-11-16T08:00:03.000Z',content:'样例工具回执：三项固定数据已读取。',data:current},
  {id:'native-thought-later',type:'thinking',status:finished()?'completed':'running',at:'2026-11-16T08:00:04.000Z',content:'专员后续思考样例：核对是否遗漏磁盘记录。',data:current},
  ...(finished()?[{id:'native-final',type:'message' as const,status:'completed',at:'2026-11-16T08:00:05.000Z',content:conclusion,data:current}]:[]),
 ];
}
function workerSnapshot():SessionSnapshot{
 const source=worker(),cards=nativeCards();
 return {session:session(sourceId,'worker'),cursor,messages:[],resources:[],actions:[],specialists:[],evidence:[],terminals:[],superagent:{roleId:source.roleId,task:source.task,execution:source.execution},
  ai:{session:sourceId,profile:'fixture',turns:1,usage:{input:0,output:0,total:0},status:finished()?'completed':stage==='waiting'?'waiting_approval':'running',replyStatus:finished()?undefined:'running',rootTurnId:author.rootTurnId,turnStartedAt:started,cards,cardsOffset:0,totalCards:cards.length}};
}
window.fetch=async input=>{
 const path=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href).pathname;
 if(path===`/api/sessions/${sourceId}/snapshot`)return Response.json(workerSnapshot());
 return Response.json({error:'fixture blocks every other API request'},{status:404});
};
function announce(){for(const stream of streams)stream.dispatchEvent(new MessageEvent('session',{data:JSON.stringify({sessionId:sourceId,seq:cursor})}));}
const channels=[{id:'channel-host',roleId:author.roleId!,roleName:author.name,avatarId:author.avatarId,sessionId:'channel-native',projectId,revision:1,createdAt:at}];
const history:Message[]=[
 {id:'old-user',sessionId:routerId,role:'user',text:'保留前一轮历史记录。',createdAt:'2026-11-16T07:50:00.000Z'},
 {id:'old-answer',sessionId:routerId,role:'assistant',text:'历史正文与 [历史链接](#history) 在后续更新中保持原节点。',createdAt:'2026-11-16T07:50:01.000Z'},
];
function pilotSnapshot(pilotDone:boolean):SessionSnapshot{
 const cards:AICard[]=[
  {id:'pilot-thought-before',type:'thinking',status:'completed',content:'Pilot 思考样例：先请专员核对，再整理结果。',at:started},
  {id:'pilot-dispatch',type:'operation',title:'route_work',status:'completed',content:'样例派单完成。',at:'2026-11-16T08:00:02.000Z'},
  {id:'pilot-public',type:'message',status:'completed',content:'已安排专员核对，我会继续检查结果是否完整。',at:'2026-11-16T08:00:03.000Z'},
  {id:'pilot-thought-after',type:'thinking',status:pilotDone?'completed':'running',content:'Pilot 后续思考样例：公开说明后仍在核对结果完整性。',at:'2026-11-16T08:00:04.000Z'},
 ];
 const report:Message={id:'native-report',sessionId:routerId,role:'assistant',author,text:conclusion,createdAt:'2026-11-16T08:00:06.000Z'};
 return {session:session(routerId,'router'),cursor,messages:[...history,{id:'current-user',sessionId:routerId,role:'user',text:'核对隔离样例，并保留思考和公开进度。',createdAt:at},...(finished()?[report]:[])],resources:[],actions:[],specialists:[],evidence:[],terminals:[],
  replyTimings:[{messageId:'current-user',startedAt:started,finishedAt:pilotDone?'2026-11-16T08:00:07.000Z':'',status:pilotDone?'completed':'running'}],
  ai:{session:routerId,profile:'fixture',turns:1,usage:{input:0,output:0,total:0},status:pilotDone?'completed':'running',turnStartedAt:started,cards,cardsOffset:0,totalCards:cards.length}};
}
type Baseline={slot:Element|null;identity:Element|null;body:Element|null;process:Element|null;history:Element|null;pilot:Element|null};
function Fixture(){
 const inspector=useSessionInspector()!;
 const [current,setCurrent]=useState(stage),[revision,setRevision]=useState(cursor),[restoration,setRestoration]=useState(0),[pilotDone,setPilotDone]=useState(false),[qa,setQA]=useState('尚未捕获基线');
 const box=useRef<HTMLDivElement>(null),baseline=useRef<Baseline|null>(null);
 const snapshot=pilotSnapshot(pilotDone),source=workerSnapshot(),owner=worker();
 const workspace:SuperWorkspace={active:true,project:{projectId,routerSessionId:routerId,version:1},workers:[owner],channels};
 const workerOpen=inspector.selection?.sessionId===sourceId;
 const inspectSpecialist=(reply:SpecialistReplyAuthor)=>{
  const resolved=specialistInspectionWorker(reply,workspace,projectId),target=resolved&&workerInspectionTarget(resolved,projectId);
  if(target&&matchesSpecialistInspection(source,target))inspector.open({sessionId:target.sessionId,canonicalGoalId:target.taskId,tab:'execution'});
 };
 const nodes=():Baseline=>{
  const root=box.current!,slot=root.querySelector(`[data-worker-id="${author.workerId}"]`);
  return {slot,identity:slot?.querySelector('.response-identity')??null,body:slot?.querySelector('.pilot-specialist-reply-content')??null,process:root.querySelector('[data-specialist-process]'),history:root.querySelector('a[href="#history"]'),pilot:root.querySelector('[data-conversation-entry="pilot-public"]')};
 };
 const measure=()=>{
  const now=nodes(),before=baseline.current;
  const runningAnimations=(node:Element|null)=>node?.getAnimations({subtree:true}).filter(animation=>animation.playState==='running')??[];
  const processAnimations=runningAnimations(now.process),prose=now.body?.querySelector('.assistant-prose')??null;
  return {stage,captured:!!before,...Object.fromEntries(Object.entries(now).map(([key,node])=>[`${key}Same`,!!node&&!!before&&node===before[key as keyof Baseline]&&node.isConnected])),
   processEntries:box.current!.querySelectorAll('[data-specialist-process]').length,conclusionCopies:box.current!.textContent?.split(conclusion).length! -1,
   reportId:now.slot?.getAttribute('data-report-id')??'',inspectorSession:inspector.selection?.sessionId??'',workerRecords:document.querySelectorAll('[data-process-card]').length,
   thinkingVisible:[...box.current!.querySelectorAll('[role="status"]')].some(node=>node.textContent?.includes('正在思考')),
   activeAnimations:runningAnimations(now.body).length,proseAnimations:runningAnimations(prose).length,proseCharacters:prose?.querySelectorAll('.live-text-motion-character').length??0,
   processAnimations:processAnimations.length,processMotion:now.process?.querySelector('[data-live-motion]')?.getAttribute('data-live-motion')??'',
   processLight:processAnimations.map(animation=>({name:animation instanceof CSSAnimation?animation.animationName:'transition',startTime:animation.startTime,duration:animation.effect?.getTiming().duration,delay:animation.effect?.getTiming().delay})),
   nameAnimations:runningAnimations(now.identity).length,proseLength:prose?.textContent?.length??0};
 };
 const capture=()=>{baseline.current=nodes();const result=measure();setQA(JSON.stringify(result));return result;};
 useLayoutEffect(()=>{Object.assign(window,{pilotProcessQA:{capture,measure}});});
 const move=(next:Stage)=>{
  stage=next;cursor++;setCurrent(next);setRevision(cursor);
  if(next==='restored'){inspector.reset();baseline.current=null;setQA('恢复历史后需重新捕获基线');setRestoration(value=>value+1);}
  announce();
 };
 return <main style={{height:'100vh',display:'flex',flexDirection:'column',padding:'16px 20px',gap:12}}>
  <header style={{display:'flex',gap:8,flexWrap:'wrap'}}>{Object.entries(stages).map(([key,label])=><button key={key} data-fixture-stage={key} aria-pressed={current===key} onClick={()=>move(key as Stage)}>{label}</button>)}
   <button onClick={()=>{setPilotDone(value=>!value);}}>切换 Pilot 完成</button>
   <button onClick={()=>{document.documentElement.dataset.theme=document.documentElement.dataset.theme==='dark'?'light':'dark';}}>切换主题</button>
   <button onClick={capture}>捕获 DOM 基线</button><button onClick={()=>setQA(JSON.stringify(measure()))}>检查节点</button>
  </header>
  <p style={{margin:0}}>当前：{stages[current]} · 快照 {revision}。本地合成数据；恢复历史会主动重新挂载主会话，其余更新保留节点。</p>
  <output data-testid="process-qa" style={{fontSize:12,overflowWrap:'anywhere',minHeight:32}}>{qa}</output>
  <div className="session-layout" style={{flex:1,border:'1px solid var(--border)',borderRadius:'var(--radius-settings-panel)'}}>
   <div className="session-view" style={{display:'flex',flexDirection:'column',flex:1,minWidth:0}}>
    <div ref={box} className="conversation" tabIndex={0} style={{overflow:'auto',padding:'24px 20px',flex:1,overflowAnchor:'none'}}>
     <SpecialistAvatarProvider channels={channels}><AITranscript key={restoration} snapshot={snapshot} pilotWorkspace={workspace} pilotConnected={stage!=='disconnected'} assistantIdentity={{name:'Pilot',pilot:true}} onInspectSpecialist={inspectSpecialist}/></SpecialistAvatarProvider>
    </div>
   </div>
   <SessionInspector key={workerOpen?sourceId:routerId} snapshot={workerOpen?source:snapshot} worker={workerOpen?owner:undefined} connected onUpdated={()=>{cursor++;setRevision(cursor);announce();}}/>
  </div>
 </main>;
}
document.documentElement.dataset.theme=new URLSearchParams(location.search).get('theme')==='dark'?'dark':'light';
createRoot(document.getElementById('root')!).render(<SessionInspectorProvider><Fixture/></SessionInspectorProvider>);
