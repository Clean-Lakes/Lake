// The real App and its two session streams, with local data only.
import './readme-workbench';
import type {AIView, Message, SessionEvent, SessionSnapshot, SpecialistConversation, SuperWorker, SuperWorkspace} from '../../../shared/contracts';

const router = 'demo-session-0', project = 'demo-project';
const baseFetch = window.fetch.bind(window);
const dialogue = new URLSearchParams(location.search).has('dialogue');
const dialogueHandoffMs = 14_010;
const started = Date.now() - 60_000;
const at = (offset: number) => new Date(started + offset).toISOString();
const source: Message = {id:'output-request', sessionId:router, role:'user', text:'核对这批样例记录', createdAt:at(0)};
const history: Message = {id:'output-history', sessionId:router, role:'assistant', text:'此前的样例记录。\n\n'.repeat(18), createdAt:at(-1000)};
const opening = '我已安排专员核对样例';
const conclusion = '样例记录一致，未发现遗漏。';
const names = ['数据库专员','可观测性专员','发布专员','知识库专员','服务器运维排查专员'];
if(dialogue)names.push('ACP 测试专员','河狸专员','巡检专员');
type Stage = 'idle' | 'started' | 'working' | 'first-report' | 'second-report' | 'closing' | 'reports-delivered' | 'finished';
type Network = 'connected' | 'worker-stream-drop' | 'worker-outage' | 'workspace-outage';
let stage: Stage = 'idle', cursor = 50;
let network: Network = 'connected';
const streams = new Set<FixtureStream>();
const workerText=new Map<string,string>();
let workerSnapshotReads=0;

function workers(): SuperWorker[] {
  if (dialogue || stage === 'idle' || stage === 'started') return [];
  return names.map((name, index) => {
    const id = `output-worker-${index}`;
    const completed = stage === 'closing' || stage === 'reports-delivered' || stage === 'finished';
    return {
      id, roleId:`output-role-${index}`, roleName:name, sessionId:id,
      assignmentState:completed ? 'parked' : 'active',
      task:{taskId:'output-task', executionGoalId:id, projectId:project, sessionId:id, title:'核对样例记录', state:completed?'completed':'running', acceptanceState:'not_evaluated', revision:1, originRootTurnId:'output-root', deadlineAt:at(120_000)},
      activity:completed ? undefined : {phase:index===0?'thinking':'tool',label:'正在核对记录',updatedAt:at(200),sourceMessageId:source.id,sourceSessionId:router},
      pilotReport:completed ? {messageId:`output-report-${index}`,executionSettled:stage==='finished'||index===0} : undefined,
    };
  });
}

function dialogueRound():SpecialistConversation {
  const settled=stage==='closing'||stage==='finished';
  return {id:'dialogue-round',projectId:project,sessionId:router,sourceMessageId:source.id,title:'专员回应样例',
    state:stage==='finished'?'completed':settled?'summarizing':'running',createdAt:at(10),deadlineAt:at(120_000),summaryRequested:true,
    members:names.map((roleName,index)=>{
      const replied=settled&&index!==7||stage==='first-report'&&index===0||stage==='second-report'&&index<2;
      const failed=settled&&index===7;
      return {id:`speaker-${index}`,roleId:`role-${index}`,roleName,sessionId:`speaker-session-${index}`,channelSessionId:`role-session-${index}`,
        state:replied?'replied':failed?'failed':stage==='started'&&index>1?'queued':'running',
        ...(replied ? {replyMessageId:`speaker-reply-${index}`} : {}),
        ...(failed ? {reason:'模型服务限流（HTTP 429）'} : {})};
    })};
}

function reports(): Message[] {
  return workers().flatMap((worker, index) => {
    if (stage !== 'finished' && stage !== 'reports-delivered' && !((stage==='first-report'||stage==='closing') && index===0)) return [];
    return [{id:`output-report-${index}`, sessionId:router, role:'assistant', text:`${worker.roleName}核对完成。`,
      createdAt:at(800+index), replyToMessageId:source.id,
      author:{kind:'specialist', name:worker.roleName, workerId:worker.id, roleId:worker.roleId, sessionId:worker.sessionId, taskId:worker.task.taskId, rootTurnId:`finish-root-${index}`}}];
  });
}

function snapshot(base: SessionSnapshot, worker?: SuperWorker): SessionSnapshot {
  const ended=stage==='finished'||stage==='reports-delivered', active=stage!=='idle'&&!ended;
  const replyRunning=worker?worker.task.state==='running':active;
  const messages=worker ? [] : [history, source, ...reports()];
  if(dialogue&&stage!=='idle'){
    const round=dialogueRound();
    for(const member of round.members)if(member.replyMessageId)messages.push({id:member.replyMessageId,sessionId:router,role:'assistant',
      createdAt:at(dialogueHandoffMs+650+messages.length),text:`${member.roleName}已核对，样例正常。`,
      author:{kind:'specialist',name:member.roleName,workerId:member.id,roleId:member.roleId,sessionId:member.sessionId,channelSessionId:member.channelSessionId,conversationId:round.id},
      conversation:{id:round.id,sourceMessageId:source.id,kind:'reply'}});
    if(ended)messages.push({id:'dialogue-summary',sessionId:router,role:'assistant',createdAt:at(dialogueHandoffMs+1000),text:'七位专员确认样例正常，有一位专员未能回应。',
      conversation:{id:round.id,sourceMessageId:source.id,kind:'summary',summaryRequested:true}});
  }
  if (ended && !worker && !dialogue) messages.push({id:'rolled-up-report',sessionId:router,role:'assistant',createdAt:at(1000),
    jointReport:{taskId:'output-task',reportId:'joint'},text:'「核对样例记录」的 5 位专员均已提交报告。\n\n'+reports().map(report=>`${report.author?.name}：${report.text}`).join('\n\n')});
  const root=worker ? `stage-root-${worker.id}` : 'output-root';
  const ai: AIView | undefined = stage==='idle' ? undefined : {
    ...base.ai!, session:worker?.sessionId??router, rootTurnId:root,
    status:replyRunning?'running':'completed', replyStatus:replyRunning?'running':'completed',
    turnStartedAt:at(10), turnFinishedAt:replyRunning?undefined:at(1000), sourceMessageIds: worker?[]:[source.id],
    pending:undefined, pendingApprovals:[], question:undefined, agentRuns:[], cardsOffset:0,
    cards:worker?[{id:`stage-${worker.id}`,type:'message',status:worker.task.state==='running'?'running':'completed',at:at(300),content:workerText.get(worker.sessionId)??'先核对版本 1.4。正在查看样例记录。',data:{root_turn_id:root}}]:stage==='started'?[]:[
      {id:'pilot-opening',type:'message',status:ended?'completed':'running',at:at(100),content:opening,data:{root_turn_id:root,source_message_id:source.id}},
      ...(ended?[{id:'pilot-verdict',type:'message' as const,status:'completed',at:at(1100),content:conclusion,data:{root_turn_id:root,source_message_id:source.id}}]:[]),
    ], totalCards:0,
  };
  if(ai&&dialogue){
    ai.status='completed';ai.replyStatus='completed';ai.turnFinishedAt=at(dialogueHandoffMs);
    ai.cards=[{id:'pilot-opening',type:'message',status:'completed',at:at(200),content:'已邀请大家逐一回应。',data:{root_turn_id:root,source_message_id:source.id}},
      {id:'pilot-invite',type:'operation',title:'convene_specialists',status:'completed',at:at(150),content:JSON.stringify(dialogueRound()),
        data:{root_turn_id:root,source_message_id:source.id}}];
  }
  if(ai)ai.totalCards=ai.cards.length;
  return {...base, cursor, messages, ai, superagent:worker?{roleId:worker.roleId, task:worker.task} as SessionSnapshot['superagent']:undefined,
    session:{...base.session,id:worker?.sessionId??router,projectId:project,title:worker?.roleName??'Pilot',workspaceRole:worker?'worker':'router',status:active?'investigating':'completed'},
    sre:undefined, actions:[], specialists:[], replyTimings:dialogue&&ai?[{messageId:source.id,startedAt:at(10),finishedAt:at(dialogueHandoffMs),status:'completed'}]:[], terminals:[]};
}

class FixtureStream extends EventTarget {
  static OPEN=1;
  readyState=1;
  onopen: ((event: Event) => void) | null=null;
  onmessage: ((event: MessageEvent<string>) => void) | null=null;
  onerror: ((event: Event) => void) | null=null;
  session: string;
  workers: Set<string>;
  constructor(value: string | URL) {
    super();
    const url=new URL(value,location.href);
    this.session=decodeURIComponent(url.pathname.split('/')[3]??'');
    this.workers=new Set(url.searchParams.getAll('worker'));
    streams.add(this);
    queueMicrotask(()=>this.connect());
  }
  connect() {
    if(this.readyState===2)return;
    this.readyState=1;
    const event=new Event('open');this.onopen?.(event);this.dispatchEvent(event);
    if(this.workers.size)this.dispatchEvent(new MessageEvent('worker-subscriptions',{data:'{}'}));
  }
  publish(event: SessionEvent) {
    if(this.readyState!==1||event.sessionId!==this.session&&!this.workers.has(event.sessionId))return;
    this.dispatchEvent(new MessageEvent(event.type,{data:JSON.stringify(event)}));
  }
  close() {this.readyState=2;streams.delete(this);}
}
window.EventSource=FixtureStream as unknown as typeof EventSource;
const json=(value:unknown,status=200)=>Response.json(value,{status});
window.fetch=async(input,init)=>{
  const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href);
  const path=url.pathname;
  if (path.startsWith('/api/') && (init?.method??'GET')!=='GET') return json({error:'Read-only fixture'},405);
  if (path===`/api/projects/${project}/superagent`) {
    if(network==='workspace-outage')return json({error:'模拟工作区刷新失败'},503);
    const value: SuperWorkspace={active:true,project:{projectId:project,routerSessionId:router,version:1},workers:workers(),
      ...(dialogue&&stage!=='idle'?{conversations:[dialogueRound()]}:{}),cursor};
    return json(value);
  }
  if (path.endsWith('/snapshot')) {
    const id=decodeURIComponent(path.split('/')[3]??'');
    if(id!==router)workerSnapshotReads++;
    if(id!==router&&network==='worker-outage')return json({error:'模拟专员快照失败'},503);
    const base: SessionSnapshot=await (await baseFetch(`/api/sessions/${router}/snapshot`)).json();
    return json(snapshot(base,workers().find(worker=>worker.sessionId===id)));
  }
  const response=await baseFetch(input,init);
  if (path==='/api/bootstrap') return json({...await response.json(),backendRuntime:'typescript',aiRuntime:'typescript'});
  return response;
};

Object.assign(window,{pilotOutputQA:{transport(){
  return {workerScopes:[...streams].filter(stream=>stream.workers.size).map(stream=>[...stream.workers]),
    workerSnapshotReads,directWorkers:[...streams].filter(stream=>stream.session.startsWith('output-worker-')).length};
},workerText(index:number,text:string){
  const worker=workers()[index];
  if(!worker)return;
  workerText.set(worker.sessionId,text);
  const event={sessionId:worker.sessionId,seq:++cursor,type:'message',textUpdate:{target:'card',cardType:'message',id:`stage-${worker.id}`,rootTurnId:`stage-root-${worker.id}`,at:at(300),content:text}} as SessionEvent;
  for(const stream of streams)stream.publish(event);
},setNetwork(next:Network){
  network=next;
  const seq=++cursor;
  for (const stream of streams) {
    const workerStream=stream.workers.size||stream.session.startsWith('output-worker-');
    if (workerStream&&(next==='worker-stream-drop'||next==='worker-outage')) {
      stream.readyState=0;
      stream.onerror?.(new Event('error'));
    } else if (stream.readyState===0) {
      stream.connect();
    }
    if(stream.session===router)stream.publish({sessionId:router,seq,type:'specialist'} as SessionEvent);
  }
},advance(next:Stage){
  stage=next;
  const seq=++cursor;
  for (const stream of streams) {
    const live=next==='working'&&stream.session===router;
    stream.publish({sessionId:stream.session,seq,type:live?'message':'specialist',
      ...(live&&{textUpdate:{target:'card',cardType:'message',id:'pilot-opening',rootTurnId:'output-root',at:at(100),content:opening}})} as SessionEvent);
    if(live)stream.publish({sessionId:router,seq:++cursor,type:'specialist'} as SessionEvent);
    for(const sessionId of stream.workers)stream.publish({sessionId,seq,type:'specialist'} as SessionEvent);
  }
}}});
