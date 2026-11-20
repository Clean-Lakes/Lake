import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {SuperTask,SuperWorker,SuperWorkerActivity,SuperWorkspace,WorkSession} from '../../shared/contracts';
import {SessionStateBadge} from '../src/SessionPresentation';
import {superPilotActivity} from '../src/superPilotActivity';

const router={id:'pilot',projectId:'project',status:'completed'} as WorkSession;
const task:SuperTask={taskId:'task',sessionId:'worker-session',projectId:'project',title:'检查服务器',state:'running',acceptanceState:'not_evaluated',revision:1,originRootTurnId:'turn',deadlineAt:''};
function worker(phase?:SuperWorkerActivity['phase'],overrides:Partial<SuperWorker>={}):SuperWorker {
 return {id:'worker',roleId:'ops',roleName:'运维专员',sessionId:task.sessionId,task,assignmentState:'active',
  activity:phase?{phase,label:phase==='tool'?'检查主机状态':'等待处理',updatedAt:'2026-11-05T12:00:00Z'}:undefined,...overrides};
}
function workspace(workers:SuperWorker[]):SuperWorkspace {
 return {active:true,project:{projectId:'project',routerSessionId:router.id,version:1},workers};
}
function badge(workspaceValue:SuperWorkspace,presentedReports?:ReadonlySet<string>) {
 return renderToStaticMarkup(createElement(SessionStateBadge,{session:router,...superPilotActivity(workspaceValue,router,true,presentedReports)}));
}

test('a completed Router reply still shows real thinking and tool activity from its workers',()=>{
 for(const phase of ['thinking','tool'] as const){
  const current=workspace([worker(phase)]),state=superPilotActivity(current,router)!;
  assert.equal(state.status,'investigating');assert.equal(state.animated,true);assert.equal(state.motion,'working');
  assert.equal(state.workerCount,1);assert.match(state.label,/运维专员/);
  const html=badge(current);
  assert.match(html,/data-badge-state="working"/);assert.match(html,/处理中/);assert.doesNotMatch(html,/已结束/);
 }
 assert.match(superPilotActivity(workspace([worker('tool')]),router)!.label,/检查主机状态/);
});

test('live approvals and questions override running work without a running animation',()=>{
 for(const phase of ['waiting_approval','waiting_input'] as const){
  const second=worker(phase,{id:'db',sessionId:'db-session',roleId:'db',roleName:'数据库专员',task:{...task,sessionId:'db-session',taskId:'db-task'}});
  const current=workspace([worker('tool'),second]),state=superPilotActivity(current,router)!;
  assert.equal(state.phase,phase);assert.equal(state.status,'waiting_approval');assert.equal(state.animated,false);assert.equal(state.motion,'still');
  assert.equal(state.workerCount,2);assert.match(state.label,/数据库专员.*运维专员/);
  const html=badge(current);assert.match(html,/data-badge-state="approval"/);assert.doesNotMatch(html,/data-badge-state="working"|已结束/);
 }
 const mixed=workspace([worker('waiting_input'),worker('waiting_approval',{id:'approval'})]);
 assert.equal(superPilotActivity(mixed,router)!.phase,'waiting_approval');
});

test('queued and external waits stay visible and still rather than claiming execution or completion',()=>{
 for(const phase of ['queued','waiting_external'] as const){
  const current=workspace([worker(phase,{assignmentState:phase==='queued'?'queued':'active'})]);
  const state=superPilotActivity(current,router)!;
  assert.equal(state.phase,phase);assert.equal(state.status,'idle');assert.equal(state.animated,false);assert.equal(state.motion,'still');
  const html=badge(current);assert.match(html,/data-badge-state="idle"/);assert.doesNotMatch(html,/data-badge-state="working"|已结束/);
 }
});

test('the compact badge shows the leading live wait and keeps every specialist in its accessible detail',()=>{
 for(const [phase,label,expected] of [
  ['queued','准备处理','准备处理'],['queued','等待开始','等待开始'],
  ['waiting_external','等待外部结果','等待外部结果'],['queued','  ','等待开始'],
 ] as const){
  const first=worker(phase,{activity:{phase,label,updatedAt:'2026-11-05T12:01:00Z'}});
  const next=worker('queued',{id:'next',roleName:'文档专员'});
  const html=badge(workspace([next,first]));
  assert.match(html,new RegExp(`class="session-state-label">${expected}</span>`));
  assert.match(html,new RegExp(`aria-label="运维专员：${expected}；文档专员：等待处理"`));
  assert.match(html,/data-badge-state="idle" data-tone="neutral"/);
  assert.doesNotMatch(html,/activity-indicator/);
 }
 const idle=renderToStaticMarkup(createElement(SessionStateBadge,{session:{...router,status:'idle'}}));
 assert.match(idle,/class="session-state-label">待命<\/span>/);
});

test('connection loss makes retained worker activity static until a live connection returns',()=>{
 const current=workspace([worker('tool')]);
 const offline=superPilotActivity(current,router,false)!;
 assert.equal(offline.status,'idle');assert.equal(offline.animated,false);assert.equal(offline.motion,'still');
 assert.equal(offline.label,'进度暂未更新，正在重连');
 const html=renderToStaticMarkup(createElement(SessionStateBadge,{session:router,...offline}));
 assert.match(html,/class="session-state-label">重连中<\/span>/);
 assert.match(html,/进度暂未更新，正在重连/);assert.match(html,/data-badge-state="idle"/);assert.doesNotMatch(html,/data-badge-state="working"|已结束/);
 const restored=superPilotActivity(current,router,true)!;
 assert.equal(restored.status,'investigating');assert.equal(restored.animated,true);assert.equal(restored.motion,'working');
 assert.equal(superPilotActivity(workspace([]),router,false),null);
});

test('completion removes aggregate activity; historical running or blocked task labels never start it',()=>{
 const current=workspace([worker('tool')]);assert.equal(superPilotActivity(current,router)!.animated,true);
 for(const state of ['completed','failed','cancelled'] as const){
  const settled=workspace([worker('tool',{task:{...task,state}})]);
  assert.equal(superPilotActivity(settled,router),null,'a terminal task cannot retain a stale live activity');
 }
 for(const state of ['running','blocked','waiting_user','paused'] as const){
  assert.equal(superPilotActivity(workspace([worker(undefined,{task:{...task,state,reason:'old unavailable adapter'}})]),router),null);
 }
 const settled=workspace([worker(undefined,{task:{...task,state:'completed',acceptanceState:'pass'},assignmentState:'parked'})]);
 assert.match(badge(settled),/已结束/);
 assert.equal(superPilotActivity(workspace([worker('tool',{assignmentState:'stopped'}),worker('tool',{assignmentState:'archived'})]),router),null);
});

test('Pilot activity cannot cross project or selected session boundaries',()=>{
 const current=workspace([worker('tool')]);
 assert.equal(superPilotActivity(current,{...router,projectId:'other-project'}),null);
 assert.equal(superPilotActivity(current,{...router,id:'role-channel'}),null);
 assert.equal(superPilotActivity({...current,active:false},router),null);
 assert.equal(superPilotActivity(undefined,router),null);assert.equal(superPilotActivity(current,undefined),null);
 assert.equal(superPilotActivity(workspace([worker('tool',{task:{...task,projectId:'other-project'}})]),router),null);
 assert.equal(superPilotActivity(workspace([worker('tool',{task:{...task,sessionId:'another-task-session'}})]),router),null);
});

test('Pilot ends only after each exact specialist report has settled and been presented',()=>{
 const report=(id:string,executionSettled:boolean)=>worker(undefined,{id,task:{...task,state:'completed'},
  assignmentState:executionSettled?'parked':'active',pilotReport:{messageId:id,executionSettled}});
 // Another worker may flush the pending message before this invocation returns.
 assert.match(badge(workspace([report('report-a',false)]),new Set(['report-a'])),/data-badge-state="working"/);
 const delivered=workspace([report('report-a',true),report('report-b',true)]);
 assert.match(badge(delivered,new Set(['report-old','report-a'])),/data-badge-state="working"/);
 assert.match(badge(delivered,new Set(['report-a','report-b'])),/已结束/);
 const otherTask=workspace([...delivered.workers,worker('waiting_approval',{id:'waiting'})]);
 assert.match(badge(otherTask,new Set()),/data-badge-state="approval"/);
 const offline=superPilotActivity(delivered,router,false,new Set());
 assert.equal(offline?.status,'idle');assert.equal(offline?.phase,'finishing');
 assert.equal(offline?.idleLabel,'重连中');assert.equal(offline?.animated,false);
 assert.equal(superPilotActivity(delivered,{...router,id:'another-pilot'},true,new Set()),null);
});

test('multiple workers prefer actual tools to queues, exclude completed workers and leave workspace order intact',()=>{
 const queued=worker('queued',{id:'queued',assignmentState:'queued'});
 const active=worker('tool',{id:'active',roleName:'数据库专员'});
 const done=worker(undefined,{id:'done',task:{...task,state:'completed'}});
 const current=workspace([queued,done,active]);Object.freeze(current.workers);
 const state=superPilotActivity(current,router)!;
 assert.equal(state.phase,'tool');assert.equal(state.workerCount,2);assert.equal(state.animated,true);
 assert.match(state.label,/^数据库专员：检查主机状态；运维专员/);
 assert.deepEqual(current.workers.map(item=>item.id),['queued','done','active']);
 const onlyQueued=superPilotActivity(workspace([queued,done]),router)!;
 assert.equal(onlyQueued.phase,'queued');assert.equal(onlyQueued.animated,false);
});

test('island includes every live role once, including a report still being presented',()=>{
 const active=Array.from({length:6},(_,index)=>worker(index===3?'waiting_input':'thinking',{
  id:`worker-${index}`,roleId:`role-${index}`,roleName:`专员 ${index}`,
 }));
 const closing=worker(undefined,{id:'report-worker',roleId:'report-role',roleName:'收尾专员',
  task:{...task,state:'completed'},pilotReport:{messageId:'finished-report',executionSettled:true}});
 const view=workspace([...active,{...active[0]!,id:'second-task'},closing]);
 const pending=superPilotActivity(view,router,true,new Set())!;
 assert.equal(pending.participants.length,7);
 assert.equal(pending.participants.find(person=>person.key==='role-3')?.moving,false);
 assert.equal(pending.participants.find(person=>person.key==='report-role')?.moving,true);
 assert.equal(superPilotActivity(view,router,true,new Set(['finished-report']))!.participants.length,6);
});
