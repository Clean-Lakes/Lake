import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {Message,SessionSnapshot,SuperWorker,SuperWorkspace} from '../../shared/contracts';
import {AITranscript} from '../src/AIPanel';
import {PilotSpecialistConversation} from '../src/PilotSpecialistConversation';
import {pilotDispatchRows,pilotSpecialistReply} from '../src/pilotSpecialistReplies';

const at='2026-11-06T00:00:00Z';
const user:Message={id:'question',sessionId:'pilot',role:'user',text:'检查服务器',createdAt:at};
const worker=(id='host'):SuperWorker=>({id,roleId:`role-${id}`,roleName:'服务器专员',sessionId:`worker-${id}`,assignmentState:'active',
 task:{taskId:`task-${id}`,sessionId:`worker-${id}`,projectId:'project',title:'读取服务器当前指标',state:'running',acceptanceState:'not_evaluated',revision:1,originRootTurnId:'root',deadlineAt:at},
 activity:{phase:'thinking',label:'正在分析',updatedAt:at,sourceSessionId:'pilot',sourceMessageId:user.id}});
const workspace=(workers=[worker()]):SuperWorkspace=>({active:true,project:{projectId:'project',routerSessionId:'pilot',version:1},workers,
 channels:workers.map(item=>({id:`channel-${item.id}`,roleId:item.roleId,roleName:item.roleName,sessionId:`channel-session-${item.id}`,projectId:'project',revision:1,createdAt:at}))});
const render=(value:SuperWorkspace,connected=true)=>renderToStaticMarkup(createElement(PilotSpecialistConversation,{rows:pilotDispatchRows(value,'pilot',[user]),onSpecialist(){},connected}));

test('Pilot retains each dispatched worker after its own reply, with exact task and channel targets',()=>{
 const a=worker(),b={...worker('database'),roleName:'数据库专员'},state=workspace([a,b]);
 const rows=pilotDispatchRows(state,'pilot',[user]);
 assert.equal(rows.length,2);assert.deepEqual(rows.map(row=>row.author.channelSessionId),['channel-session-host','channel-session-database']);
 assert.deepEqual(rows.map(row=>row.author.taskId),['task-host','task-database']);
 const snapshot={session:{id:'pilot',workspaceRole:'router'},messages:[user,{id:'reply',sessionId:'pilot',role:'assistant',text:'我会检查这两项。',createdAt:at}],resources:[],actions:[],ai:{session:'pilot',status:'completed',cards:[],cardsOffset:0}} as SessionSnapshot;
 const before=JSON.stringify(snapshot);
 const html=renderToStaticMarkup(createElement(AITranscript,{snapshot,pilotWorkspace:state,assistantIdentity:{name:'Pilot',pilot:true},onSpecialist(){}}));
 assert.ok(html.indexOf('我会检查这两项。')<html.indexOf('pilot-specialist-reply'));
 assert.equal((html.match(/data-worker-id=/g)??[]).length,2);
 assert.ok(html.includes('turn-activity-mark')&&html.includes('data-motion="working"'));
 assert.ok(html.includes('<strong>服务器专员</strong>')&&html.includes('<strong>数据库专员</strong>'));
 assert.doesNotMatch(html,/pilot-dispatch-progress|专员工作进展/);
 assert.equal(JSON.stringify(snapshot),before,'live progress must never be persisted as a reply or report');
});

test('queued, human confirmation, questions and external waits stay static; only current work moves',()=>{
 for(const phase of ['queued','thinking','tool','waiting_approval','waiting_input','waiting_external'] as const){
  const item=worker();item.activity!.phase=phase;item.activity!.label=phase==='queued'?'准备处理':phase.startsWith('waiting')?'等待确认':'正在分析';
  const html=render(workspace([item])),moving=['thinking','tool'].includes(phase);
  assert.equal(html.includes('turn-activity-mark'),moving,phase);assert.equal(html.includes('data-motion="working"'),moving,phase);
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

test('live authors use the original execution and only exact delivered roots retire a live reply',()=>{
 const item=worker();item.execution={backend:{kind:'acp',agent:'codex'},source:'task_assignment',assignedAt:at,runs:[],totalRuns:0};
 const state=workspace([item]);state.channels![0].execution={kind:'native'};
 const row=pilotDispatchRows(state,'pilot',[user])[0]!;
 assert.equal(row.author.execution?.kind,'acp');assert.match(render(state),/Agent 类型：Codex/);
 const report:Message={id:'report',sessionId:'pilot',role:'assistant',text:'实际结果',createdAt:at,author:{...row.author,rootTurnId:'reported-root'}};
 const other:Message={...report,id:'other',author:{...row.author,workerId:'another-worker',rootTurnId:'unrelated-root'}};
 assert.deepEqual(pilotDispatchRows(state,'pilot',[user,report,other])[0]!.reportedTurns,['reported-root']);
 item.parentWorkerId='parent';
 assert.deepEqual(pilotDispatchRows(state,'pilot',[user]),[],'native children are not additional conversation participants');
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
 const html=renderToStaticMarkup(createElement(AITranscript,{snapshot,pilotWorkspace:workspace(),assistantIdentity:{name:'Pilot',pilot:true},onSpecialist(){}}));
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
