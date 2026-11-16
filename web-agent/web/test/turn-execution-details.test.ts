import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {AICard,AIView,ReplyTiming} from '../../shared/contracts';
import type {InspectorSelection} from '../src/SessionInspectorContext';
import {canonicalExecutionSelected,TurnExecutionDetails} from '../src/TurnExecutionDetails';

const start='2026-11-16T03:00:00Z';
const timing:ReplyTiming={messageId:'request',startedAt:start,finishedAt:'',status:'running'};
const progress:AICard={id:'progress',type:'message',status:'completed',content:'已安排专员核对。',at:start};
function renderStatus(cards:AICard[],view:Partial<AIView>={}){
 return renderToStaticMarkup(createElement(TurnExecutionDetails,{
  timing,cards,view:{session:'pilot',status:'running',turnStartedAt:start,cards,...view} as AIView,
  assistantIdentity:{name:'Pilot',pilot:true},presentingReply:true,
  details:[createElement('p',{key:'record'},'已保留的执行过程')],
  children:createElement('p',{},progress.content),
 }));
}

test('public progress does not hide later thinking or the retained execution records',t=>{
 t.mock.method(Date,'now',()=>Date.parse(start)+19000);
 const cards:AICard[]=[{id:'dispatch',type:'operation',title:'route_work',status:'completed',at:start},progress,{id:'reasoning',type:'thinking',status:'running',content:'继续核对结果',at:start}];
 const html=renderStatus(cards);
 assert.ok(html.includes('已安排专员核对。')&&html.includes('正在思考…'));
 assert.ok(html.includes('turn-thinking-avatar')&&html.includes('status-text--active'));
 assert.ok(html.includes('已保留的执行过程')&&html.includes('aria-expanded="false"'));
 assert.ok(!html.includes('is-preview'));
 assert.ok(html.indexOf('已安排专员核对。')<html.indexOf('class="reply-duration '));
});

test('a displayed reply does not conceal live tools, waits or context compaction',t=>{
 t.mock.method(Date,'now',()=>Date.parse(start)+19000);
 const streaming:AICard={...progress,id:'reply',status:'running'};
 const cases:{cards:AICard[];view?:Partial<AIView>;state:string}[]=[
  {cards:[{id:'tool',type:'operation',title:'inspect_host',status:'running',at:start},streaming],state:'正在执行工具…'},
  {cards:[streaming],view:{status:'waiting_approval'},state:'等待确认'},
  {cards:[streaming],view:{status:'waiting_input'},state:'等待你补充信息'},
  {cards:[streaming],view:{status:'waiting_external'},state:'等待外部结果'},
  {cards:[streaming],view:{status:'queued'},state:'排队等待'},
  {cards:[{id:'compact',type:'compaction',status:'running',at:start},streaming],state:'正在压缩上下文…'},
  {cards:[streaming],view:{status:'failed'},state:'未完成'},
 ];
 for(const {cards,view,state} of cases){
  const html=renderStatus(cards,view);
  assert.ok(html.includes(state),state);
  assert.ok(!html.includes('is-preview'),state+' must not use the conclusion preview clock');
  assert.ok(html.includes('已保留的执行过程')&&html.includes('aria-expanded="false"'),state);
 }
});

test('only an actual public reply stream uses the conclusion preview',t=>{
 t.mock.method(Date,'now',()=>Date.parse(start)+19000);
 const html=renderStatus([{...progress,status:'running'}]);
 assert.ok(html.includes('is-preview')&&html.includes('用时 19秒'));
 assert.ok(!html.includes('正在思考…')&&!html.includes('status-text--active'));
 assert.ok(html.includes('aria-expanded="false"')&&html.includes('已保留的执行过程'));
 const afterStream=renderStatus([progress]);
 assert.ok(afterStream.includes('正在思考…')&&!afterStream.includes('is-preview'),'completed public text alone is not a final answer while the turn is running');
});

test('canonical execution disclosure belongs to the selected session, goal and tab',()=>{
 const selection:InspectorSelection={sessionId:'pilot',canonicalGoalId:'goal',tab:'execution'};
 assert.equal(canonicalExecutionSelected(selection,'pilot','goal'),true);
 for(const other of [null,undefined,{...selection,sessionId:'other-session'},{...selection,canonicalGoalId:'other-goal'},{...selection,tab:'plan' as const}]){
  assert.equal(canonicalExecutionSelected(other,'pilot','goal'),false);
 }
});
