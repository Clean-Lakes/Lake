import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {SessionSnapshot,SuperTask,SuperWorkspace,WorkGoal} from '../../shared/contracts';
import {SessionStateBadge} from '../src/SessionPresentation';
import {superTaskHeaderPresentation} from '../src/superAgentPresentation';
import {superPilotActivity} from '../src/superPilotActivity';
import {workGoalPresentation} from '../src/workGoalPresentation';

function snapshot():SessionSnapshot {
 const task:SuperTask={taskId:'historical-inline-task',sessionId:'pilot',projectId:'project',title:'先前调查',state:'paused',acceptanceState:'insufficient',revision:1,originRootTurnId:'old-root',deadlineAt:''};
 const goal={id:task.taskId,sessionId:task.sessionId,projectId:task.projectId,originRootTurnId:task.originRootTurnId,status:'paused'} as WorkGoal;
 return {session:{id:'pilot',projectId:'project',title:'Pilot',workspaceRole:'router',status:'completed'},messages:[],resources:[],actions:[],evidence:[],
  ai:{session:'pilot',status:'completed',rootTurnId:'current-root',cards:[],cardsOffset:0,workGoals:[goal]},superagent:{task}} as SessionSnapshot;
}
function workspace():SuperWorkspace {
 return {active:true,project:{projectId:'project',routerSessionId:'pilot',version:1},workers:[{
  id:'latest-worker',roleId:'ops',roleName:'运维专员',sessionId:'latest-worker',assignmentState:'parked',
  task:{taskId:'latest-task',sessionId:'latest-worker',projectId:'project',title:'当前检查',state:'completed',acceptanceState:'pass',revision:1,originRootTurnId:'worker-root',deadlineAt:''},
 }]};
}
function badge(s:SessionSnapshot,w=workspace(),connected=true) {
 // The header uses this same precedence: real project activity, selected
 // invocation/task presentation, then the current turn's goal/session state.
 const presentation=superPilotActivity(w,s.session,connected)??superTaskHeaderPresentation(s.superagent?.task,s)??workGoalPresentation(s);
 return renderToStaticMarkup(createElement(SessionStateBadge,{session:s.session,...presentation}));
}

test('a completed delegation cannot inherit the Router historical inline pause',()=>{
 const s=snapshot(),before=JSON.stringify(s);
 assert.equal(workGoalPresentation(s),undefined);
 assert.match(badge(s),/data-badge-state="ended"/);
 assert.doesNotMatch(badge(s),/已暂停|需关注/);
 assert.equal(JSON.stringify(s),before,'status projection leaves the old task and goal untouched');
 for(const state of ['paused','blocked'] as const){
  s.superagent!.task={...s.superagent!.task,state,reason:state==='blocked'?'token_limit_removed':undefined};
  assert.match(badge(s),/data-badge-state="ended"/);
 }
});

test('the current Router inline pause remains visible, with actual live replies taking priority',()=>{
 const s=snapshot();s.ai!.rootTurnId='old-root';
 assert.match(badge(s),/data-badge-state="paused"/);
 s.ai!.replyStatus='running';
 assert.match(badge(s),/data-badge-state="working"/);
 assert.doesNotMatch(badge(s),/已暂停/);
 s.ai!.replyStatus='waiting_approval';
 assert.match(badge(s),/data-badge-state="approval"/);
 s.ai!.replyStatus='completed';
 assert.match(badge(s),/data-badge-state="paused"/);
});

test('live sibling activity wins and settling it restores the current reply rather than an old pause',()=>{
 const s=snapshot(),w=workspace(),worker=w.workers[0];
 worker.task.state='running';worker.assignmentState='active';worker.activity={phase:'tool',label:'检查主机状态',updatedAt:'2026-11-10T05:00:00Z'};
 assert.match(badge(s,w),/data-badge-state="working"/);
 assert.match(badge(s,w,false),/进度暂未更新，正在重连/);
 assert.doesNotMatch(badge(s,w,false),/data-badge-state="working"/);
 worker.activity={...worker.activity,phase:'waiting_approval'};
 assert.match(badge(s,w),/data-badge-state="approval"/);
 worker.task.state='completed';worker.assignmentState='parked';delete worker.activity;
 assert.match(badge(s,w),/data-badge-state="ended"/);
});

test('unidentified turns and foreign task ownership cannot lend a pause to this Router',()=>{
 const s=snapshot();delete s.ai!.rootTurnId;
 delete (s.ai!.workGoals![0] as Partial<WorkGoal>).originRootTurnId;
 assert.equal(workGoalPresentation(s),undefined);
 assert.match(badge(s),/data-badge-state="ended"/);
 s.ai!.rootTurnId='old-root';
 s.superagent!.task.sessionId='different-worker';
 assert.equal(superTaskHeaderPresentation(s.superagent!.task,s),undefined);
 s.superagent!.task.sessionId='pilot';s.superagent!.task.projectId='different-project';
 assert.equal(superTaskHeaderPresentation(s.superagent!.task,s),undefined);
});

test('selecting the exact paused Worker or its role channel still exposes its canonical pause',()=>{
 const s=snapshot();s.session.workspaceRole='worker';s.ai!.rootTurnId='restored-invocation';
 assert.match(badge(s),/data-badge-state="paused"/);
 s.session.workspaceRole='role';s.session.id='role-channel';
 assert.match(badge(s),/data-badge-state="paused"/);
 s.ai!.replyStatus='running';
 assert.match(badge(s),/data-badge-state="working"/);
});
