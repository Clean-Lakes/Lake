import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {InspectorTaskSummary,inspectorProgress} from '../src/InspectorTaskSummary';
import assert from 'node:assert/strict';
import test from 'node:test';
import {islandFixture} from './fixtures/pilot-island-data';
import {inspectedTask,inspectedAttempt,inspectorAttempts} from '../src/sessionInspectorModel';

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
