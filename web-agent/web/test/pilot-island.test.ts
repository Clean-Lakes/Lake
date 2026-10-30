import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {pilotIslandAnimating,pilotIslandModel} from '../src/pilotIslandModel';
import {PilotHeaderState} from '../src/PilotHeaderState';
import {PilotStatusIsland} from '../src/PilotStatusIsland';
import {islandFixture} from './fixtures/pilot-island-data';
import {sreStepStatus} from '../src/sreTranscript';
import {sreRoleLiveState} from '../src/SREActivity';

test('Pilot island follows actual parallel specialists and completed steps, never tool counts', () => {
  const snapshot = islandFixture(), model = pilotIslandModel(snapshot)!;
  assert.equal(model.label, '并行协作'); assert.equal(model.completed, 3); assert.equal(model.total, 8);
  assert.deepEqual(model.visibleRoles.map(r => r.role), ['investigator', 'verifier']);
  assert.deepEqual(model.roles.map(r => [r.role, r.completed, r.total]), [['coordinator', 1, 2], ['investigator', 1, 4], ['verifier', 1, 2]]);
  for (const a of snapshot.ai!.agentRuns!) {a.toolCount = 200; a.activityUpdatedAt = '2026-10-26T12:00:00Z'; a.liveText = '持续叙述';}
  assert.deepEqual(pilotIslandModel(snapshot), model);
  const html = renderToStaticMarkup(createElement(PilotStatusIsland, {model, onInspect() {}}));
  assert.ok(html.includes('stroke-dasharray="37.5 100"'));
  assert.ok(html.includes('pilot-island-action') && html.includes('pilot-island-ring'));
  assert.ok(!html.includes('持续叙述') && !html.includes('workspace-header-sweep'));
  const three = pilotIslandModel(islandFixture('parallel3'))!;
  assert.deepEqual(three.visibleRoles.map(r => r.role), ['coordinator', 'investigator', 'verifier']);
  assert.equal(three.completed, 2); assert.match(three.detail, /3 位专员执行中/);
});

test('one waiting specialist does not hide another running specialist', () => {
  for (const [state, label] of [['choice', '等待选择'], ['approval', '等待审批']] as const) {
    const model = pilotIslandModel(islandFixture(state))!;
    assert.equal(model.label, label); assert.equal(model.tone, 'attention'); assert.equal(model.completed, 3);
    assert.equal(model.roles.find(r => r.role === 'verifier')!.status, 'running');
    assert.match(model.detail, /1 位专员继续执行/);
  }
});

test('a live operation does not hide a second pending approval in the same specialist', () => {
  const snapshot = islandFixture('approval');
  snapshot.sre!.tasks[0]!.attempts.find(a => a.stepId === 'logs')!.operations = [{id: 'live', risk: 'readonly', status: 'dispatched', call: {name: 'read', arguments: '{}'}}] as never;
  assert.equal(pilotIslandModel(snapshot)!.label, '等待审批');
});

test('queued specialists do not count as concurrent execution', () => {
  const snapshot = islandFixture();
  snapshot.ai!.agentRuns!.find(a => a.workflowStepId === 'logs')!.status = 'queued';
  const one = pilotIslandModel(snapshot)!;
  assert.equal(one.label, '独立复核'); assert.match(one.detail, /1 位专员执行中/); assert.match(one.detail, /1 位专员排队中/);
  snapshot.ai!.agentRuns!.find(a => a.workflowStepId === 'verify-logs')!.status = 'queued';
  const both = pilotIslandModel(snapshot)!;
  assert.equal(both.label, '排队中'); assert.equal(both.tone, 'neutral'); assert.equal(both.completed, 3);
});

test('ordinary supplementary questions are not mistaken for Pilot direction choices or executing work', () => {
  const snapshot = islandFixture('choice'), agent = snapshot.ai!.agentRuns!.find(a => a.question)!;
  delete agent.question!.pilot;
  const model = pilotIslandModel(snapshot)!;
  assert.equal(model.label, '等待补充'); assert.match(model.detail, /1 位专员继续执行/);
  const task = snapshot.sre!.tasks[0]!, step = task.plans[0]!.steps.find(s => s.id === 'logs')!, attempt = task.attempts.find(a => a.stepId === step.id)!;
  assert.equal(sreStepStatus(task, step, snapshot.ai!.agentRuns), 'waiting_input');
  const live = sreRoleLiveState(task, task.messages.find(m => m.attemptId === attempt.id)!, agent, attempt);
  assert.equal(live.active, false); assert.equal(live.label, '等待补充');
  const paused = sreRoleLiveState({...task, status: 'paused'}, task.messages.find(m => m.attemptId === attempt.id)!, agent, attempt);
  assert.equal(paused.active, false); assert.equal(paused.label, '已暂停');
});

test('pause is neutral despite stale agent activity; in-flight commands still disclose stopping', () => {
  const paused = pilotIslandModel(islandFixture('paused'))!;
  assert.equal(paused.label, '已暂停'); assert.equal(paused.tone, 'neutral'); assert.equal(paused.completed, 3);
  assert.ok(paused.steps.every(s => s.status !== 'running'));
  const stopping = pilotIslandModel(islandFixture('stopping'))!;
  assert.equal(stopping.label, '正在暂停'); assert.match(stopping.detail, /原操作仍在执行/);
  assert.equal(stopping.tone,'neutral');
  assert.equal(pilotIslandAnimating(stopping),false);
  assert.equal(pilotIslandAnimating({...stopping,tone:'active'}),false);
  assert.equal(pilotIslandAnimating(paused),false);
  assert.equal(pilotIslandAnimating(pilotIslandModel(islandFixture())),true);
  assert.equal(pilotIslandAnimating(pilotIslandModel(islandFixture('unknown'))),false);
  assert.equal(stopping.roles.find(r => r.role === 'verifier')!.status, 'paused');
});

test('unknown changes and actual read failures cannot be hidden by peers or a pause', () => {
  assert.equal(pilotIslandModel(islandFixture('unknown'))!.label, '变更待核实');
  const failed = pilotIslandModel(islandFixture('failed'))!;
  assert.equal(failed.label, '检查未完成'); assert.equal(failed.tone, 'failed'); assert.equal(failed.completed, 3);
});

test('resume counts reused completed attempts once; new plan revisions start their own denominator', () => {
  assert.equal(pilotIslandModel(islandFixture('resume'))!.completed, 3);
  const snapshot = islandFixture('revised'), changed = pilotIslandModel(snapshot)!;
  assert.equal(changed.planId, 'revised-plan'); assert.equal(changed.completed, 0); assert.equal(changed.total, 8);
  // Proposed operations already completed are still not a completed deliverable.
  const work = islandFixture(); work.sre!.tasks[0]!.attempts.find(a => a.stepId === 'logs')!.operations = [{id: 'read', status: 'succeeded', risk: 'readonly', call: {name: 'read', arguments: '{}'}}] as never;
  assert.equal(pilotIslandModel(work)!.completed, 3);
});

test('completed steps ignore stale questions and conclusion uncertainty is preserved', () => {
  const snapshot = islandFixture('finished');
  snapshot.ai!.agentRuns!.find(a => a.workflowStepId === 'logs')!.question = islandFixture('choice').ai!.agentRuns!.find(a => a.question)!.question;
  const finished = pilotIslandModel(snapshot)!;
  assert.equal(finished.completed, 8); assert.equal(finished.label, '调查结束'); assert.match(finished.detail, /结论不充分/);
  assert.equal(pilotIslandModel(islandFixture('cancelled'))!.label, '已取消');
});

test('disabled, foreign and later ordinary turns keep the original session island', () => {
  const off = islandFixture(); off.sre!.pilot!.enabled = false; assert.equal(pilotIslandModel(off), null);
  const legacy = islandFixture(); delete legacy.sre!.tasks[0]!.pilot; const history = JSON.stringify(legacy);
  assert.equal(pilotIslandModel(legacy)!.completed, 3); assert.equal(JSON.stringify(legacy), history);
  const foreign = islandFixture(); foreign.sre!.tasks[0]!.sessionId = 'another-session'; assert.equal(pilotIslandModel(foreign), null);
  const later = islandFixture('finished'); later.ai!.turnStartedAt = '2026-10-26T01:00:00Z'; assert.equal(pilotIslandModel(later), null);
  const latest = islandFixture(); latest.sre!.tasks.push({...latest.sre!.tasks[0]!, id: 'newer', createdAt: '2026-10-26T00:01:00.100Z', pilot: undefined}); assert.equal(pilotIslandModel(latest)!.taskId, 'newer');
});

test('planning has no invented steps, percentage or unused execution role', () => {
  const planning = pilotIslandModel(islandFixture('planning'))!;
  assert.equal(planning.label, '制定计划'); assert.equal(planning.total, 0); assert.equal(planning.roles[0]!.role, 'coordinator');
  const html = renderToStaticMarkup(createElement(PilotStatusIsland, {model: planning, onInspect() {}}));
  assert.ok(!html.includes('0 / 0') && !html.includes('%') && !html.includes('执行员'));
  const empty = islandFixture('planning');
  Object.assign(empty.sre!.tasks[0]!, {plans: null, runs: null, attempts: null, messages: null});
  assert.equal(pilotIslandModel(empty)!.total, 0);
  empty.sre!.tasks = null as never;
  assert.equal(pilotIslandModel(empty), null);
});

// The server uses waiting_approval for aggregate question waits too. A concrete
// Pilot question identifies the actual intervention, while real approvals win.
test('aggregate approval state does not mislabel concrete Pilot choices',()=>{
 const snapshot=islandFixture('choice');snapshot.sre!.tasks[0]!.status='waiting_approval';
 assert.equal(pilotIslandModel(snapshot)!.label,'等待选择');
 const ordinary=snapshot.ai!.agentRuns!.find(a=>a.question)!;delete ordinary.question!.pilot;
 assert.equal(pilotIslandModel(snapshot)!.label,'等待补充');
 const approval=islandFixture('approval');approval.sre!.tasks[0]!.status='waiting_approval';
 assert.equal(pilotIslandModel(approval)!.label,'等待审批');
});

test('current action prioritizes intervention, keeps peer activity and real counts',async()=>{
 const {pilotIslandFocus}=await import('../src/pilotIslandModel');
 const snapshot=islandFixture();
 const investigator=snapshot.ai!.agentRuns!.find(a=>a.workflowStepId==='logs')!;
 investigator.activityPhase='tool';investigator.activityTool='read';
 let focus=pilotIslandFocus(pilotIslandModel(snapshot)!);
 assert.equal(focus.primary?.role,'investigator');assert.equal(focus.action,'读取文件与日志');assert.match(focus.secondary,/验证员/);
 focus=pilotIslandFocus(pilotIslandModel(islandFixture('choice'))!);
 assert.equal(focus.action,'等待选择');assert.match(focus.secondary,/验证员/);
 assert.equal(pilotIslandFocus(pilotIslandModel(islandFixture('paused'))!).action,'已暂停');
 assert.equal(pilotIslandFocus(pilotIslandModel(islandFixture('unknown'))!).action,'待核实');
});


test('terminal task status replaces the progress ring without claiming recovery verification',()=>{
 const render=(snapshot:ReturnType<typeof islandFixture>)=>renderToStaticMarkup(createElement(PilotStatusIsland,{model:pilotIslandModel(snapshot)!,onInspect(){}}));
 const finished=render(islandFixture('finished'));
 assert.ok(finished.includes('pilot-island-ended')&&!finished.includes('pilot-island-ring'));
 assert.ok(finished.includes('任务已结束')&&finished.includes('结论不充分'));
 assert.ok(!finished.includes('验收已通过'));
 const active=islandFixture('finished');active.sre!.tasks[0]!.status='active';
 assert.ok(render(active).includes('pilot-island-ring'));
 assert.ok(render(islandFixture('cancelled')).includes('任务已取消'));
 assert.ok(render(islandFixture('unknown')).includes('pilot-island-ring'));
});

test('historical paused Pilot does not replace a later independent turn; in-flight effects remain visible',()=>{
 const s=islandFixture('paused');s.ai!.turnStartedAt='2027-01-01T00:00:00Z';s.ai!.status='completed';
 assert.equal(pilotIslandModel(s),null);
 const t=s.sre!.tasks[0]!;
 t.attempts[0]!.operations=[{status:'unknown',risk:'readonly'}] as typeof t.attempts[number]['operations'];
 assert.equal(pilotIslandModel(s),null,'an old incomplete read does not label the later turn');
 t.attempts[0]!.operations[0]!.risk='write';
 assert.equal(pilotIslandModel(s)?.label,'变更待核实');
});

test('current failed investigation takes precedence over a historical draining task',()=>{
 const s=islandFixture('failed'), current=s.sre!.tasks[0]!;
 s.ai!.status='failed';
 const historical=structuredClone(islandFixture('stopping').sre!.tasks[0]!);
 historical.id='historical-drain'; historical.createdAt=historical.updatedAt='2026-10-25T00:00:00Z';
 s.sre!.tasks.push(historical);
 const saved=JSON.stringify(historical);
 assert.equal(pilotIslandModel(s)?.taskId,current.id);
 assert.equal(pilotIslandModel(s)?.label,'检查未完成');
 assert.equal(pilotIslandAnimating(pilotIslandModel(s)),false);
 assert.equal(JSON.stringify(historical),saved,'historical ledger must remain intact');
 historical.status='cancelled';historical.updatedAt='2026-10-26T00:02:00Z';
 assert.equal(pilotIslandModel(s)?.taskId,current.id,'late cleanup of an old dispatch must not replace the current task');
});


test('Pilot headers retain the specialist entry through execution and completion, then restore ordinary controls', () => {
  for (const state of ['running', 'finished', 'paused', 'unknown'] as const) {
    const html = renderToStaticMarkup(createElement(PilotHeaderState, {
      model: pilotIslandModel(islandFixture(state)), normal: createElement('span', null, '普通状态'),
      onInspect() {}, details: {available: true, open: false, toggle() {}},
    }));
    assert.match(html, /header-pilot-state is-visible"[^>]*aria-hidden="false"/);
    assert.match(html, /header-normal-state"[^>]*aria-hidden="true"[^>]*inert/);
    assert.match(html, /class="pilot-island-trigger"[^>]*aria-label="Lake Pilot：/);
    assert.doesNotMatch(html, /class="pilot-island-trigger"[^>]*disabled/);
  }
  const ordinary = renderToStaticMarkup(createElement(PilotHeaderState, {
    model: null, normal: createElement('span', null, '普通状态'), onInspect() {},
    details: {available: true, open: false, toggle() {}},
  }));
  assert.match(ordinary, /header-normal-state is-visible"[^>]*aria-hidden="false"/);
  assert.match(ordinary, /aria-label="展开执行详情"/);
  assert.doesNotMatch(ordinary, /class="pilot-island-trigger"/);
});


test('enabled Pilot retains its mode entry after an ordinary follow-up without reviving old specialist activity',()=>{
 const snapshot=islandFixture('finished');snapshot.ai!.turnStartedAt='2027-01-01T00:00:00Z';
 const model=pilotIslandModel(snapshot);assert.equal(model,null);
 for(const mode of ['auto','manual'] as const){
  const html=renderToStaticMarkup(createElement(PilotHeaderState,{model,mode,normal:createElement('span',null,'已结束'),onInspect(){},details:{available:true,open:false,toggle(){}}}));
  assert.match(html,/header-pilot-state is-visible"[^>]*aria-hidden="false"/);
  assert.match(html,/header-normal-state"[^>]*aria-hidden="true"[^>]*inert/);
  assert.ok(html.includes(mode==='auto'?'自动推进':'手动选择'));
  assert.ok(html.includes('本轮没有专员任务')&&html.includes('展开执行详情'));
  assert.ok(html.includes('sre-avatar-coordinator')&&html.includes('aria-label="协调者入口"'));
  assert.ok(!html.includes('pilot-island-progress')&&!html.includes('pilot-action-avatar'));
  assert.ok(!html.includes('调查结束')&&!html.includes('验收已通过'));
 }
});
