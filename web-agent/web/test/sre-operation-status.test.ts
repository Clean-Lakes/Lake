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
