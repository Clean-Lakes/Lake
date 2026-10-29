import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {SRETask,WorkSession} from '../../shared/contracts';
import {sreSessionPresentation} from '../src/sreSessionPresentation';
import {SessionStateBadge} from '../src/SessionPresentation';
import {sessionBadgeState} from '../src/sessionBadgeState';
const session={id:'s',status:'completed'} as WorkSession;
test('a completed model reply cannot turn paused, failed or cancelled SRE tasks green',()=>{
 for(const [status,label] of [['paused','任务已暂停'],['failed','任务未完成'],['cancelled','任务已取消']] as const){
  const props=sreSessionPresentation(session,[{status,attempts:[]} as unknown as SRETask]);
  const html=renderToStaticMarkup(createElement(SessionStateBadge,{session,...props}));
  assert.ok(html.includes(label));assert.ok(html.includes('state-failed'));assert.ok(!html.includes('已完成'));
 }
 const props=sreSessionPresentation(session,[{status:'completed',outcome:'inconclusive',attempts:[]} as unknown as SRETask]);
 assert.equal(props.label,'调查结束 · 结论不充分');assert.equal(props.status,'failed');
});

test('only a successful fresh read covers a previous timeout',async()=>{
 const {sreIncompleteRead}=await import('../src/sreOperationPolicy');
 const original={risk:'readonly',status:'unknown',digest:'query',call:{name:'shell',arguments:'{}'}} as import('../../shared/contracts').SREOperation;
 for(const status of ['prepared','not_executed','failed','rejected','succeeded'])assert.equal(sreIncompleteRead([original,{...original,status}]),status!=='succeeded');
});

 test('a later ordinary turn does not inherit a historical terminal or paused result',()=>{
  const old={status:'completed',outcome:'inconclusive',updatedAt:'2026-10-26T00:00:00Z',attempts:[]} as unknown as SRETask;
  assert.deepEqual(sreSessionPresentation(session,[old],'2026-10-26T00:00:00.001Z'),{});
  assert.equal(sreSessionPresentation(session,[old],'2026-10-25T00:00:00Z').status,'failed');
  for(const status of ['failed','cancelled','paused','waiting_input','draft'])assert.deepEqual(sreSessionPresentation(session,[{...old,status} as SRETask],'2026-10-26T00:00:01Z'),{});
  // A pause or draft inside the current turn still describes it.
  for(const [status,label] of [['paused','任务已暂停'],['waiting_input','任务待继续'],['draft','任务待继续']] as const){
   assert.equal(sreSessionPresentation(session,[{...old,status,updatedAt:'2026-10-26T00:00:02Z'} as SRETask],'2026-10-26T00:00:01Z').label,label);
  }
  for(const [status,risk,label] of [['unknown','change','变更待核实'],['dispatched','readonly','原操作仍在执行']]){
   const task={...(old as SRETask),status:'paused',attempts:[{operations:[{status,risk}]}]} as unknown as SRETask;
   assert.deepEqual(sreSessionPresentation(session,[task],'2026-10-26T00:00:01Z'),{});
   assert.equal(sreSessionPresentation(session,[{...task,updatedAt:'2026-10-26T00:00:02Z'}],'2026-10-26T00:00:01Z').label,label);
  }
 });

test('historical dispatched operations cannot revive a failed compaction turn',()=>{
 const failed={...session,status:'failed' as const};
 const historical=['cancelled','paused'].map(status=>({status,updatedAt:'2026-10-26T15:57:17Z',attempts:[{operations:[{status:'dispatched',risk:'readonly'}]}]} as unknown as SRETask));
 const props=sreSessionPresentation(failed,historical,'2026-10-29T02:15:21Z');
 assert.deepEqual(props,{});
 const html=renderToStaticMarkup(createElement(SessionStateBadge,{session:failed,...props}));
 assert.ok(html.includes('需关注'));
 assert.ok(!html.includes('处理中'));
 assert.equal(historical[0]!.attempts[0]!.operations[0]!.status,'dispatched','audit records remain unresolved');
});

test('an earlier pause cannot hide the current failed task',()=>{
 const at='2026-10-26T00:00:00Z';
 const old={status:'paused',updatedAt:'2020-01-01T00:00:00Z',attempts:[]} as unknown as SRETask;
 const current={status:'failed',updatedAt:at,attempts:[]} as unknown as SRETask;
 assert.equal(sreSessionPresentation(session,[current,old],at).label,'任务未完成');
});

test('fixed badge labels retain SRE uncertainty and distinguish a pause from failure',()=>{
 const examples=[
  ['paused','任务已暂停','已暂停','neutral'],
  ['waiting_input','任务待继续','已暂停','neutral'],
  ['cancelled','任务已取消','已停止','neutral'],
  ['failed','任务未完成','需关注','attention'],
  ['completed','调查结束 · 结论不充分','需关注','attention'],
 ] as const;
 for(const [status,detail,visible,tone] of examples){
  const props=sreSessionPresentation(session,[{status,outcome:status==='completed'?'inconclusive':undefined,attempts:[]} as unknown as SRETask]);
  const html=renderToStaticMarkup(createElement(SessionStateBadge,{session,...props}));
  assert.ok(html.includes(`title="${detail}"`));
  assert.ok(html.includes(`class="session-state-label">${visible}</span>`));
  assert.ok(html.includes(`data-tone="${tone}"`));
  assert.ok(!html.includes('data-badge-state="ended"'));
 }
 assert.equal(sessionBadgeState('failed','变更待核实').tone,'attention');
 // A pause request cannot hide an operation that is still dispatched.
 assert.equal(sessionBadgeState('investigating','原操作仍在执行').label,'处理中');
 assert.equal(sessionBadgeState('waiting_approval','任务已完成').label,'待确认');
});

test('unrecognized detail text stays in the tooltip, not in the fixed badge label',()=>{
 const html=renderToStaticMarkup(createElement(SessionStateBadge,{session,label:'服务端的详细结果说明'}));
 assert.ok(html.includes('title="服务端的详细结果说明"'));
 assert.ok(html.includes('class="session-state-label">已结束</span>'));
 assert.ok(html.includes('session-state-icon'));
});
