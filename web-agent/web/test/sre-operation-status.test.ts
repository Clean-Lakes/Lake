import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {SRETask,WorkSession} from '../../shared/contracts';
import {sreSessionPresentation} from '../src/sreSessionPresentation';
import {SessionStateBadge} from '../src/SessionPresentation';
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
   assert.equal(sreSessionPresentation(session,[task],'2026-10-26T00:00:01Z').label,label);
  }
 });

test('an earlier pause cannot hide the current failed task',()=>{
 const at='2026-10-26T00:00:00Z';
 const old={status:'paused',updatedAt:'2020-01-01T00:00:00Z',attempts:[]} as unknown as SRETask;
 const current={status:'failed',updatedAt:at,attempts:[]} as unknown as SRETask;
 assert.equal(sreSessionPresentation(session,[current,old],at).label,'任务未完成');
});
