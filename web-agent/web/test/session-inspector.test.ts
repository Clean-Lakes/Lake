import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {InspectorTaskSummary,inspectorProgress} from '../src/InspectorTaskSummary';
import assert from 'node:assert/strict';
import test from 'node:test';
import {islandFixture} from './fixtures/pilot-island-data';
import {canonicalGoalForExecution,hasInspectorTask,inspectedTask,inspectedAttempt,inspectorAttempts,latestInspectorSelection,resolvedInspectorSelection} from '../src/sessionInspectorModel';
import type {SessionSnapshot} from '../../shared/contracts';

test('native task execution is not an empty chat turn when child records exist without parent cards',()=>{
 const snapshot={session:{id:'worker-session',projectId:'project'},superagent:{task:{taskId:'task',sessionId:'worker-session',projectId:'project'}},messages:[],ai:{cards:[],agentRuns:[{id:'child',source:'zcode_subagent',taskId:'task',status:'running'}]}} as unknown as SessionSnapshot;
 const selection={sessionId:'worker-session',canonicalGoalId:'task',tab:'execution' as const};
 assert.equal(hasInspectorTask(snapshot,selection),true);
 assert.equal(hasInspectorTask({...snapshot,ai:{...snapshot.ai!,agentRuns:[]}},selection),true,'the known task also survives a lagging child projection');
 assert.equal(hasInspectorTask(snapshot,{...selection,canonicalGoalId:'another-task'}),false);
 assert.equal(hasInspectorTask(snapshot,{...selection,sessionId:'another-session'}),false);
 assert.equal(hasInspectorTask({...snapshot,superagent:{task:{...snapshot.superagent!.task,projectId:'another-project'}}},selection),false);
});

test('the inspector uses the authoritative task and rejects another session or project',()=>{
 const snapshot=islandFixture(),task=snapshot.sre!.tasks[0]!;
 const target={sessionId:snapshot.session.id,taskId:task.id,tab:'plan' as const,task:{...task,revision:0}};
 assert.equal(inspectedTask(snapshot,target),task);
 assert.equal(inspectedTask(snapshot,{...target,sessionId:'other-session'}),undefined);
 const empty={...snapshot,sre:{...snapshot.sre!,tasks:[]}};
 assert.equal(inspectedTask(empty,target),target.task);
 assert.equal(inspectedTask(empty,{...target,task:{...task,projectId:'another-project'}}),undefined);
 assert.equal(inspectedTask(empty,{...target,task:{...task,sessionId:'another-session'}}),undefined);
});

test('a selected historical attempt keeps its original plan after a revision and rerun',()=>{
 const task=islandFixture().sre!.tasks[0]!,previous=task.plans[0]!,old=task.attempts.find(a=>a.stepId==='logs')!;
 task.plans.push({...previous,id:'revised-plan',version:2,steps:previous.steps.map(s=>({...s,description:'新步骤 '+s.description}))});
 task.runs.push({...task.runs[0]!,id:'new-run',planRevisionId:'revised-plan'});
 task.attempts.push({...old,id:'new-attempt',planRunId:'new-run'});
 assert.equal(inspectedAttempt(task,old.id)!.attempt,old);
 assert.equal(inspectedAttempt(task,old.id)!.step.description,'核对日志与错误来源');
 assert.equal(inspectedAttempt(task)!.attempt.id,'new-attempt');
 assert.deepEqual(inspectorAttempts(task).map(item=>item.attempt.id),['new-attempt']);
});

test('steps without dispatched attempts do not acquire another step’s records',()=>{
 const task=islandFixture().sre!.tasks[0]!;
 assert.ok(!inspectorAttempts(task).some(item=>item.step.id==='disk'));
 assert.equal(inspectedAttempt(task,'attempt-logs')!.step.id,'logs');
 assert.equal(inspectedAttempt(task,'attempt-verify-logs')!.step.id,'verify-logs');
});


test('all completed steps remain distinct from an inconclusive finding',()=>{
 const task=islandFixture('finished').sre!.tasks[0]!;
 const html=renderToStaticMarkup(createElement(InspectorTaskSummary,{task,title:'主机检查'}));
 assert.equal(inspectorProgress(task).completed,8);
 assert.ok(html.includes('步骤全部完成')&&html.includes('结论不充分'));
 assert.ok(html.includes('aria-valuenow="8"')&&html.includes('data-tone="attention"'));
 assert.ok(!html.includes('恢复已验证'));
 const revised={...task,plans:[...task.plans,{...task.plans[0]!,id:'new-plan',version:2}]};
 assert.equal(inspectorProgress(revised).completed,0,'old run success cannot fill a revised plan');
});

test('paused and ended tasks cannot keep stale running segment states',()=>{
 const snapshot=islandFixture(),task=snapshot.sre!.tasks[0]!;
 assert.ok(inspectorProgress(task).steps.some(step=>step.status==='running'));
 for(const status of ['paused','cancelled','failed','completed']){
  const progress=inspectorProgress({...task,status});
  assert.equal(progress.completed,3);
  assert.ok(!progress.steps.some(step=>step.status==='running'),status);
 }
 const unknown=islandFixture('unknown').sre!.tasks[0]!;
 const html=renderToStaticMarkup(createElement(InspectorTaskSummary,{task:unknown,title:'待核实'}));
 assert.ok(html.includes('执行结果待核实')&&!html.includes('恢复已验证'));
});

test('header opens latest execution without restoring the last historical turn or attempt',()=>{
 const snapshot=islandFixture();snapshot.sre!.pilot!.enabled=false;
 const current=latestInspectorSelection(snapshot,'plan');
 assert.deepEqual(current,{sessionId:snapshot.session.id,tab:'execution',followLatest:true});
 const history={sessionId:snapshot.session.id,turnId:'old-turn',taskId:'old-task',attemptId:'old-attempt',tab:'execution' as const};
 assert.equal(resolvedInspectorSelection(snapshot,history),history,'manual history stays pinned');
 assert.deepEqual(resolvedInspectorSelection(snapshot,{...history,followLatest:true}),current,'follow latest drops saved history IDs');
 assert.equal(resolvedInspectorSelection(snapshot,{...history,sessionId:'other-session'}),null);
});
test('a new ordinary user turn cannot display an earlier Pilot task while its snapshot is catching up',()=>{
 const snapshot=islandFixture(),task=snapshot.sre!.tasks[0]!;
 snapshot.messages=[{id:'new-user',sessionId:snapshot.session.id,role:'user',text:'检查另一个资源',createdAt:'2026-10-26T00:02:00Z'}];
 assert.equal(latestInspectorSelection(snapshot).taskId,undefined,'old root and active task are not the new user turn');
 snapshot.ai!.turnStartedAt='2026-10-26T00:02:01Z';snapshot.ai!.rootTurnId='new-root';
 assert.equal(latestInspectorSelection(snapshot).taskId,undefined);
 task.createdAt='2026-10-26T00:02:01Z';
 assert.equal(latestInspectorSelection(snapshot,'plan').taskId,task.id);
});
test('latest Pilot follows real root-bound continuation while explicit historical attempts stay selected',()=>{
 const snapshot=islandFixture(),task=snapshot.sre!.tasks[0]!;
 snapshot.messages=[{id:'follow-up',sessionId:snapshot.session.id,role:'user',text:'继续验证',createdAt:'2026-10-26T00:02:00Z'}];
 snapshot.ai!.turnStartedAt='2026-10-26T00:02:01Z';
 const current=latestInspectorSelection(snapshot,'plan');
 assert.equal(current.taskId,task.id);assert.equal(current.followLatest,true);
 const history={sessionId:snapshot.session.id,taskId:task.id,attemptId:task.attempts[0]!.id,tab:'execution' as const};
 assert.equal(resolvedInspectorSelection(snapshot,history),history);
});

test('direct Pilot history disclosures resolve their own task rather than the latest task',()=>{
 const snapshot={session:{id:'pilot',projectId:'project'},superagent:{task:{taskId:'new',sessionId:'pilot',projectId:'project'}}} as unknown as SessionSnapshot;
 const old={...snapshot.superagent!.task,taskId:'old'};
 assert.equal(canonicalGoalForExecution(snapshot,[{data:{taskId:'old'}} as any],[old]),'old');
 assert.equal(canonicalGoalForExecution(snapshot,[{data:{taskId:'new'}} as any],[old]),'new');
 assert.equal(canonicalGoalForExecution(snapshot,[{data:{taskId:'old'}} as any],[{...old,projectId:'other'}]),undefined);
 assert.equal(canonicalGoalForExecution(snapshot,[],[old]),undefined,'an empty historical turn never borrows the latest task');
});
