import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {Message,SessionSnapshot,SuperWorker,SuperWorkspace} from '../../shared/contracts';
import {AITranscript} from '../src/AIPanel';
import {loadPilotSpecialistSnapshot,PilotSpecialistConversation,PilotSpecialistReplyView} from '../src/PilotSpecialistConversation';
import {pilotDispatchRows,pilotSpecialistReply} from '../src/pilotSpecialistReplies';

const at='2026-11-06T00:00:00Z';
const user:Message={id:'question',sessionId:'pilot',role:'user',text:'检查服务器',createdAt:at};
const worker=(id='host'):SuperWorker=>({id,roleId:`role-${id}`,roleName:'服务器专员',sessionId:`worker-${id}`,assignmentState:'active',
 task:{taskId:`task-${id}`,sessionId:`worker-${id}`,projectId:'project',title:'读取服务器当前指标',state:'running',acceptanceState:'not_evaluated',revision:1,originRootTurnId:'root',deadlineAt:at},
 activity:{phase:'thinking',label:'正在分析',updatedAt:at,sourceSessionId:'pilot',sourceMessageId:user.id}});
const workspace=(workers=[worker()]):SuperWorkspace=>({active:true,project:{projectId:'project',routerSessionId:'pilot',version:1},workers,
 channels:workers.map(item=>({id:`channel-${item.id}`,roleId:item.roleId,roleName:item.roleName,sessionId:`channel-session-${item.id}`,projectId:'project',revision:1,createdAt:at}))});
const render=(value:SuperWorkspace,connected=true)=>renderToStaticMarkup(createElement(PilotSpecialistConversation,{rows:pilotDispatchRows(value,'pilot',[user]),onSpecialist(){},connected}));

test('Pilot shows each exact dispatched worker and its thinking text below the source reply',()=>{
 const a=worker(),b={...worker('database'),roleName:'数据库专员'},state=workspace([a,b]);
 const rows=pilotDispatchRows(state,'pilot',[user]);
 assert.equal(rows.length,2);assert.deepEqual(rows.map(row=>row.author.channelSessionId),['channel-session-host','channel-session-database']);
 assert.deepEqual(rows.map(row=>row.author.taskId),['task-host','task-database']);
 const snapshot={session:{id:'pilot',workspaceRole:'router'},messages:[user,{id:'reply',sessionId:'pilot',role:'assistant',text:'我会检查这两项。',createdAt:at}],resources:[],actions:[],ai:{session:'pilot',status:'completed',cards:[],cardsOffset:0}} as SessionSnapshot;
 const before=JSON.stringify(snapshot);
 const html=renderToStaticMarkup(createElement(AITranscript,{snapshot,pilotWorkspace:state,assistantIdentity:{name:'Pilot',pilot:true},onSpecialist(){}}));
 assert.ok(html.indexOf('我会检查这两项。')<html.indexOf('pilot-specialist-reply'));
 assert.equal((html.match(/data-worker-id=/g)??[]).length,2);
 assert.equal((html.match(/data-live-motion="active"/g)??[]).length,4);
 assert.equal((html.match(/data-live-glow="active"/g)??[]).length,4);
 assert.doesNotMatch(html,/animal-thinking-bubble|animal-thinking-character|turn-activity-mark|status-text--active/);
 const names=[...html.matchAll(/<strong>([\s\S]*?)<\/strong>/g)].map(match=>match[1].replace(/<[^>]*>/g,''));
 assert.ok(names.includes('服务器专员')&&names.includes('数据库专员'));
 assert.doesNotMatch(html,/pilot-dispatch-progress|专员工作进展/);
 assert.equal(JSON.stringify(snapshot),before,'live progress must never be persisted as a reply or report');
});

test('queued, human confirmation, questions and external waits stay static; only current work moves',()=>{
 for(const phase of ['queued','thinking','tool','waiting_approval','waiting_input','waiting_external'] as const){
  const item=worker();item.activity!.phase=phase;item.activity!.label=phase==='queued'?'准备处理':phase.startsWith('waiting')?'等待确认':'正在分析';
  const html=render(workspace([item]));
  assert.doesNotMatch(html,/animal-thinking-bubble|data-motion="thinking"/,phase);
  assert.ok(html.includes('pilot-specialist-reply'),phase);
  assert.equal(html.includes('pilot-specialist-thinking-label'),phase==='thinking',phase);
  assert.equal(html.includes('data-live-glow="active"'),phase==='thinking'||phase==='tool',phase);
  assert.doesNotMatch(html,/turn-activity-mark/,phase);assert.equal(html.includes('data-motion="working"'),phase==='tool'||phase==='thinking',phase);
 }
 const offline=render(workspace(),false);
 assert.ok(offline.includes('进度暂未更新，正在重连'));assert.ok(!offline.includes('data-motion="working"')&&!offline.includes('turn-activity-mark'));
});

test('specialist conversation reads only the exact current invocation public prose',()=>{
 const item=worker(),row=pilotDispatchRows(workspace([item]),'pilot',[user])[0]!;
 const snapshot={session:{id:item.sessionId,projectId:'project'},superagent:{roleId:item.roleId,task:item.task},cursor:1,ai:{session:item.sessionId,status:'running',rootTurnId:'current',turnStartedAt:'2026-11-06T00:00:01Z',cards:[
  {id:'old',type:'message',status:'completed',at,content:'OLD_RESULT',data:{root_turn_id:'old'}},
  {id:'private',type:'thinking',status:'running',at:'2026-11-06T00:00:01Z',content:'PRIVATE_THINKING',data:{root_turn_id:'current'}},
  {id:'tool',type:'operation',status:'completed',at:'2026-11-06T00:00:01Z',content:'RAW_TOOL_OUTPUT',data:{root_turn_id:'current'}},
  {id:'public',type:'message',status:'running',at:'2026-11-06T00:00:02Z',content:'正在核对 GOS 的项目目录。',data:{root_turn_id:'current'}},
 ],cardsOffset:0,totalCards:4}} as SessionSnapshot;
 const before=JSON.stringify(snapshot);
 assert.equal(pilotSpecialistReply(row,snapshot)?.card?.content,'正在核对 GOS 的项目目录。');
 for(const changed of [
  {...snapshot,session:{...snapshot.session,projectId:'other'}},
  {...snapshot,session:{...snapshot.session,id:'other'}},
  {...snapshot,superagent:{...snapshot.superagent!,roleId:'other'}},
  {...snapshot,superagent:{...snapshot.superagent!,task:{...item.task,taskId:'other'}}},
 ])assert.equal(pilotSpecialistReply(row,changed),undefined);
 assert.equal(pilotSpecialistReply({...row,sourceCreatedAt:'2026-11-06T00:00:03Z'},snapshot),undefined,'a followup cannot borrow an older reply');
 assert.equal(pilotSpecialistReply({...row,activity:{...row.activity,phase:'queued'}},snapshot),undefined);
 assert.equal(JSON.stringify(snapshot),before);
});

test('Pilot live loading preserves the SDK root instead of the task inspector root and rejects changed ownership',async t=>{
 const item=worker();item.task.originRootTurnId='super-task-origin';
 item.task.executionGoalId='execution-goal';
 const row=pilotDispatchRows(workspace([item]),'pilot',[user])[0]!;
 // Shape observed in installed Lake Dev: the task origin and the current SDK
 // invocation differ; ?taskId projects only ai.rootTurnId to the task origin.
 const snapshot={session:{id:item.sessionId,projectId:'project'},superagent:{roleId:item.roleId,task:{...item.task}},cursor:4,
  ai:{session:item.sessionId,status:'running',replyStatus:'running',rootTurnId:'turn-current-sdk',turnStartedAt:'2026-11-06T00:00:01Z',cards:[
   {id:'current-message',type:'message',status:'running',at:'2026-11-06T00:00:02Z',content:'本次隔离验收正文已经开始输出。',data:{root_turn_id:'turn-current-sdk',taskId:'execution-goal'}},
  ],cardsOffset:0,totalCards:1}} as SessionSnapshot;
 const scoped={...snapshot,ai:{...snapshot.ai!,rootTurnId:item.task.originRootTurnId}};
 assert.equal(pilotSpecialistReply(row,scoped)?.card,undefined,'the inspector root cannot stand in for the current model invocation');
 let response=snapshot;const calls:{url:string;signal?:AbortSignal|null}[]=[];
 t.mock.method(globalThis,'fetch',async(input:string,init?:RequestInit)=>{
  calls.push({url:String(input),signal:init?.signal});
  return Response.json(String(input).includes('?taskId=')?scoped:response);
 });
 const controller=new AbortController();
 const loaded=await loadPilotSpecialistSnapshot(row,controller.signal);
 assert.deepEqual(calls,[{url:`/api/sessions/${item.sessionId}/snapshot`,signal:controller.signal}]);
 assert.equal(pilotSpecialistReply(row,loaded)?.card?.content,snapshot.ai!.cards[0]!.content);
 const html=renderToStaticMarkup(createElement(PilotSpecialistReplyView,{row,snapshot:loaded}));
 assert.match(html.replace(/<[^>]*>/g,''),/本次隔离验收正文已经开始输出/);
 assert.doesNotMatch(html,/animal-thinking-bubble|正在生成回复/);
 assert.equal(renderToStaticMarkup(createElement(PilotSpecialistReplyView,{row:{...row,reportedTurns:['turn-current-sdk']},snapshot:loaded})),'','a delivered report retires only this exact live SDK invocation');
 assert.match(renderToStaticMarkup(createElement(PilotSpecialistReplyView,{row:{...row,reportedTurns:['super-task-origin']},snapshot:loaded})),/class="specialist-reply-cursor"/,'task origin is not proof that the current public reply was delivered');
 for(const changed of [
  {...snapshot,session:{...snapshot.session,id:'other-session'}},
  {...snapshot,session:{...snapshot.session,projectId:'other-project'}},
  {...snapshot,superagent:{...snapshot.superagent!,roleId:'other-role'}},
  {...snapshot,superagent:{...snapshot.superagent!,task:{...item.task,taskId:'other-task'}}},
  {...snapshot,superagent:{...snapshot.superagent!,task:{...item.task,executionGoalId:'other-execution'}}},
 ]){response=changed;assert.equal(await loadPilotSpecialistSnapshot(row),undefined,'current snapshot still requires every exact ownership binding');}
});

test('live authors use the original execution and only exact delivered roots retire a live reply',()=>{
 const item=worker();item.execution={backend:{kind:'acp',agent:'codex'},source:'task_assignment',assignedAt:at,runs:[],totalRuns:0};
 const state=workspace([item]);state.channels![0].execution={kind:'native'};
 const row=pilotDispatchRows(state,'pilot',[user])[0]!;
 assert.equal(row.author.execution?.kind,'acp');item.activity!.phase='tool';assert.match(render(state),/Agent 类型：Codex/);
 const report:Message={id:'report',sessionId:'pilot',role:'assistant',text:'实际结果',createdAt:at,author:{...row.author,rootTurnId:'reported-root'}};
 const other:Message={...report,id:'other',author:{...row.author,workerId:'another-worker',rootTurnId:'unrelated-root'}};
 assert.deepEqual(pilotDispatchRows(state,'pilot',[user,report,other])[0]!.reportedTurns,['reported-root']);
 item.parentWorkerId='parent';
 assert.deepEqual(pilotDispatchRows(state,'pilot',[user]),[],'native children are not additional conversation participants');
});

test('Codex public root-worker text is projected from its exact ACP run, without exposing ordinary operations or child output',()=>{
 const item=worker();item.execution={backend:{kind:'acp',agent:'codex'},source:'task_assignment',assignedAt:at,totalRuns:1,runs:[{id:'acp-run',agent:'codex',scope:'worker',state:'running',dispatchPhase:'sent',createdAt:at,updatedAt:at,usage:null}]};
 const row=pilotDispatchRows(workspace([item]),'pilot',[user])[0]!;
 const card={id:'acp-run',type:'operation',status:'running',at,content:'Codex 正在核对项目目录。',data:{source:'external_agent',external_run_id:'acp-run',taskId:item.task.taskId,root_turn_id:'current'}};
 const snapshot={session:{id:item.sessionId,projectId:'project'},superagent:{roleId:item.roleId,task:item.task,execution:item.execution},cursor:1,ai:{session:item.sessionId,status:'running',rootTurnId:'current',turnStartedAt:at,cards:[card],cardsOffset:0,totalCards:1}} as SessionSnapshot;
 assert.equal(pilotSpecialistReply(row,snapshot)?.card?.content,card.content);
 const segmented={...card,data:{...card.data,external_reply:{id:'message-final',content:'仅结论'}}};
 const selected=pilotSpecialistReply(row,{...snapshot,ai:{...snapshot.ai!,cards:[segmented]}})?.card;
 assert.equal(selected?.id,'message-final');assert.equal(selected?.content,'仅结论');
 assert.equal(segmented.content,card.content,'the original cumulative audit is unchanged');
 for(const wrong of [{...card,data:{...card.data,source:'tool'}},{...card,data:{...card.data,taskId:'another-task'}},{...card,data:{...card.data,childSessionId:'child'}},{...card,data:{...card.data,root_turn_id:'old'}}]){
  assert.equal(pilotSpecialistReply(row,{...snapshot,ai:{...snapshot.ai!,cards:[wrong]}})?.card,undefined);
 }
 item.execution.runs[0].scope='segment';
 assert.equal(pilotSpecialistReply(row,snapshot)?.card,undefined);
 assert.equal(snapshot.ai!.cards[0].type,'operation','projection does not rewrite the original execution card');
});

test('settled workers disappear independently, while stale business states and unrelated channels never invent progress',()=>{
 const a=worker(),b=worker('database'),state=workspace([a,b]);
 a.task.state='completed';a.task.acceptanceState='pass';
 assert.deepEqual(pilotDispatchRows(state,'pilot',[user]).map(row=>row.worker.id),['database']);
 b.activity=undefined;b.assignmentState='parked';
 for(const status of ['running','waiting_user','paused','blocked'] as const){b.task.state=status;assert.deepEqual(pilotDispatchRows(state,'pilot',[user]),[]);}
 assert.deepEqual(pilotDispatchRows(workspace(),'another-pilot',[user]),[]);
 const direct=worker();direct.activity!.sourceSessionId='specialist-channel';
 assert.deepEqual(pilotDispatchRows(workspace([direct]),'pilot',[user]),[],'direct specialist work is not an invented Pilot dispatch');
});

test('a followup moves the same worker to its exact new user turn, with committed dispatch anchoring but no invented activity',()=>{
 const item=worker(),followup={...user,id:'followup',text:'再试试'};
 item.activity!.sourceMessageId=followup.id;
 assert.equal(pilotDispatchRows(workspace([item]),'pilot',[user,followup])[0]!.sourceMessageId,followup.id);
 item.activity={phase:'queued',label:'准备处理',updatedAt:at};item.assignmentState='queued';
 const dispatch:Message={id:'dispatch',sessionId:'pilot',role:'assistant',text:'',createdAt:at,dispatch:{id:'decision',sourceMessageId:followup.id,workerId:item.id,sessionId:item.sessionId,taskId:item.task.taskId,roleId:item.roleId,roleName:item.roleName,channelSessionId:'exact-channel',instruction:'继续检查',action:'followup'}};
 const rows=pilotDispatchRows(workspace([item]),'pilot',[user,followup,dispatch]);
 assert.equal(rows[0]!.sourceMessageId,followup.id);assert.equal(rows[0]!.activity.phase,'queued');
 assert.deepEqual(pilotDispatchRows(workspace([item]),'pilot',[user]),[],'a worker alone is not proof of a Pilot dispatch');
 item.activity.sourceSessionId='specialist-channel';
 assert.deepEqual(pilotDispatchRows(workspace([item]),'pilot',[user,followup,dispatch]),[],'a new specialist-channel invocation cannot borrow an older Pilot dispatch');
 item.activity=undefined;
 for(const assignmentState of ['active','queued']){item.assignmentState=assignmentState;assert.deepEqual(pilotDispatchRows(workspace([item]),'pilot',[user,followup,dispatch]),[],'assignment state cannot substitute for live host activity');}
 item.activity={phase:'thinking',label:'正在分析',updatedAt:at,sourceMessageId:user.id,sourceSessionId:'pilot'};
 assert.deepEqual(pilotDispatchRows(workspace([item]),'pilot',[followup]),[],'clipped historical work must not move below an unrelated latest user message');
});

test('current progress stays below its source reply when newer unrelated dialogue arrives',()=>{
 const later={...user,id:'later',text:'另一件事',createdAt:'2026-11-06T00:00:02Z'};
 const snapshot={session:{id:'pilot',workspaceRole:'router'},messages:[user,{id:'reply',sessionId:'pilot',role:'assistant',text:'已经安排检查。',createdAt:'2026-11-06T00:00:01Z'},later],resources:[],actions:[],ai:{session:'pilot',status:'completed',cards:[],cardsOffset:0}} as SessionSnapshot;
 const state=workspace();state.workers[0]!.activity!.phase='tool';
 const html=renderToStaticMarkup(createElement(AITranscript,{snapshot,pilotWorkspace:state,assistantIdentity:{name:'Pilot',pilot:true},onSpecialist(){}}));
 assert.ok(html.indexOf('已经安排检查。')<html.indexOf('data-worker-id="host"'));
 assert.ok(html.indexOf('data-worker-id="host"')<html.indexOf('class="user-message-text">另一件事'));
});

test('completed specialists leave their distinct formal reports without another live conversation copy',()=>{
 const a=worker(),b={...worker('release'),roleName:'发布专员'},state=workspace([a,b]);
 const reports:Message[]=[a,b].map((item,index)=>{
  item.task.state='completed';item.assignmentState='parked';
  return {id:`report-${index}`,sessionId:'pilot',role:'assistant',text:index?'发布查询结果。':'服务器检查结果。',createdAt:`2026-11-06T00:00:0${index+1}Z`,author:{kind:'specialist',name:item.roleName,roleId:item.roleId,workerId:item.id,sessionId:item.sessionId,taskId:item.task.taskId,rootTurnId:`root-${index}`}};
 });
 const snapshot={session:{id:'pilot',workspaceRole:'router'},messages:[user,...reports],resources:[],actions:[],ai:{session:'pilot',status:'completed',cards:[],cardsOffset:0}} as SessionSnapshot;
 const html=renderToStaticMarkup(createElement(AITranscript,{snapshot,pilotWorkspace:state,assistantIdentity:{name:'Pilot',pilot:true},onSpecialist(){}}));
 assert.equal(html.split('服务器检查结果。').length-1,1);assert.equal(html.split('发布查询结果。').length-1,1);
 assert.doesNotMatch(html,/pilot-specialist-reply|pilot-dispatch-progress/);
});

const releaseReport:Message={
 id:'report-host',sessionId:'pilot',role:'assistant',replyToMessageId:user.id,text:'发布记录核对完成。',
 createdAt:'2026-11-06T00:00:03Z',
 author:{kind:'specialist',name:'发布专员',roleId:'role-host',workerId:'host',sessionId:'worker-host',taskId:'task-host',durationMs:282000},
 files:[{sourceId:'report-file',name:'发布记录.txt'}],
 codexActivity:[
  {kind:'text',id:'interim',text:'正在读取发布记录。'},
  {kind:'integration',id:'read',text:'读取记录',status:'completed',at},
  {kind:'text',id:'result',text:'发布记录核对完成。'},
 ],
};
function renderedReport(messages:Message[],status='completed',pilotWorkspace=workspace([])){
 const snapshot={session:{id:'pilot',projectId:'project',workspaceRole:'group'},messages:[user,...messages],
  resources:[],actions:[],ai:{session:'pilot',status,cards:[],cardsOffset:0}} as SessionSnapshot;
 return renderToStaticMarkup(createElement(AITranscript,{
  snapshot,pilotWorkspace,assistantIdentity:{name:'Lake',pilot:true},onInspectSpecialist(){},
 }));
}
const collapsedExecution=/<button[^>]*data-placement="inline"[^>]*aria-label="查看执行过程"[^>]*aria-expanded="false"/;

test('a finished single-specialist report has one inline process footer after the conclusion and attachments',()=>{
 const state=workspace();
 state.workers=[];
 state.channels!.push(...workspace([worker('database')]).channels!);
 const html=renderedReport([releaseReport],'completed',state);
 const footer=html.match(collapsedExecution);
 assert.ok(footer);
 assert.equal(html.match(/aria-label="查看执行过程"/g)?.length,1);
 const attachment=html.indexOf('aria-label="下载 发布记录.txt"');
 assert.ok(attachment>html.indexOf('发布记录核对完成。')&&attachment<footer.index!);
 const duration=html.indexOf('4 分钟 42 秒');
 const hiddenProcess=html.indexOf('class="pilot-report-body" aria-hidden="true" inert=""');
 assert.ok(footer.index!<duration&&duration<hiddenProcess&&hiddenProcess<html.indexOf('正在读取发布记录。'));
 assert.equal(html.split('发布记录核对完成。').length-1,1);
 assert.doesNotMatch(html,/data-placement="side"[^>]*data-specialist-process="task-host"/);
});

test('unfinished work or a dispatch to another specialist prevents the single-specialist fold',()=>{
 for(const status of ['running','paused','waiting_approval']){
  assert.doesNotMatch(renderedReport([releaseReport],status),collapsedExecution,status);
 }
 const otherDispatch:Message={
  id:'another-dispatch',sessionId:'pilot',role:'assistant',text:'',createdAt:'2026-11-06T00:00:01Z',
  dispatch:{id:'dispatch',sourceMessageId:user.id,roleId:'another-role',roleName:'发布专员',
   workerId:'another-worker',sessionId:'another-session',taskId:'another-task',channelSessionId:'another-channel',instruction:'复核',action:'create'},
 };
 assert.doesNotMatch(renderedReport([otherDispatch,releaseReport]),collapsedExecution);
 const newerQuestion={...user,id:'newer',createdAt:'2026-11-06T00:00:02Z'};
 const delayedDispatch={...otherDispatch,createdAt:'2026-11-06T00:00:04Z'};
 assert.doesNotMatch(renderedReport([releaseReport,newerQuestion,delayedDispatch]),collapsedExecution);
 assert.doesNotMatch(renderedReport([{...releaseReport,text:''}]),collapsedExecution);
 const settling=worker();
 settling.task.state='completed';
 settling.pilotReport={messageId:releaseReport.id,executionSettled:false};
 assert.doesNotMatch(renderedReport([releaseReport],'completed',workspace([settling])),collapsedExecution);
});
