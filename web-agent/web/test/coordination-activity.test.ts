import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {AICard,SessionSnapshot} from '../../shared/contracts';
import {AITranscript} from '../src/AIPanel';
import {quietCoordination} from '../src/coordinationActivity';
import {turnProgress} from '../src/activity';
import {turnStatus} from '../src/turnStatus';
import {liveTurnProgress} from '../src/liveTurnProgress';

const at='2026-11-05T00:00:00Z';
const operation=(title='route_work',status='running'):AICard=>({id:'route',at,type:'operation',title,status,data:{arguments:{action:'ask'}},content:'original routing record'});
const snapshot=(cards:AICard[]):SessionSnapshot=>({session:{id:'pilot',workspaceRole:'router'},messages:[{id:'u',sessionId:'pilot',role:'user',text:'再试试',createdAt:at}],resources:[],actions:[],ai:{session:'pilot',status:'running',turnStartedAt:at,cards,cardsOffset:0}} as SessionSnapshot);
const render=(s:SessionSnapshot,mode:'conversation'|'activity'='conversation')=>renderToStaticMarkup(createElement(AITranscript,{snapshot:s,mode,assistantIdentity:{name:'Pilot',pilot:true}}));

test('exact host coordination waits with water waves, keeps audit closed and never creates an execution reply bubble',()=>{
 for(const title of ['route_work','list_specialists','manage_specialist','search_super_tasks','read_super_object','work_begin','work_read','work_update','work_wait','work_finish'])for(const status of ['running','completed']){
  const card=operation(title,status),s=snapshot([card]),before=JSON.stringify(s),html=render(s);
  assert.ok(html.includes('正在思考…')&&html.includes('turn-activity-mark'),title+' '+status);
  assert.ok(!html.includes('turn-progress-reply')&&!html.includes('turn-current-step'),title+' '+status);
  assert.ok(html.includes('class="turn-execution-details" aria-hidden="true" inert=""'),'internal records remain closed until explicitly requested');
  assert.ok(!html.includes('class="turn-execution-details is-open"'));
  assert.equal(turnStatus(undefined,s.ai,[card],at,Date.parse(at)+5000).state,'正在思考…');
  assert.equal(turnProgress(s.ai!,[card],at,Date.parse(at)+5000).activity?.text,'正在思考');
  assert.equal(liveTurnProgress([{id:card.id,at,card}]),undefined);
  assert.ok(render(s,'activity').includes('aria-label="思考与操作过程"'),'the original operation remains in the inspectable activity view');
  assert.equal(JSON.stringify(s),before);
 }
});

test('route ask progresses through empty text to the real answer without a generic execution bubble',()=>{
 const s=snapshot([operation('route_work','completed')]);
 s.ai!.cards.push({id:'reply',at,type:'message',status:'running',content:''});
 assert.ok(render(s).includes('正在思考…'));
 s.ai!.cards.at(-1)!.content='你想重试哪一项？';
 const streaming=render(s);
 assert.ok(streaming.includes('你想重试哪一项？'));
 assert.ok(!streaming.includes('turn-progress-reply')&&!streaming.includes('turn-current-step')&&!streaming.includes('turn-activity-mark'));
 s.ai!.status='completed';s.ai!.cards.at(-1)!.status='completed';
 assert.ok(render(s).includes('你想重试哪一项？'));
 assert.ok(!render(s).includes('turn-progress-reply'));
});

test('real and unknown tools keep their execution progress even beside coordination',()=>{
 for(const title of ['inspect_host','shell','call_mcp_tool','route_work_extra']){
  const card=operation(title),s=snapshot([operation('route_work','completed'),{...card,id:'real'}]);
  assert.equal(quietCoordination(card),false);
  assert.equal(turnStatus(undefined,s.ai,s.ai!.cards,at,Date.parse(at)+5000).state,'正在执行工具…');
  const html=render(s);
  assert.ok(!html.includes('turn-progress-reply'),'tool activity cannot synthesize an assistant reply');
  assert.ok(html.includes('class="turn-execution-details" aria-hidden="true" inert=""'));
  assert.ok(html.includes('正在执行工具'),'actual execution keeps its status and inspection entry');
 }
});

test('coordination approval and failure states remain visible and never become quiet metadata',()=>{
 for(const [status,label] of [['pending','待确认'],['failed','失败'],['unknown','结果待核查'],['not_executed','未执行'],['interrupted','已停止'],['cancelled','已停止'],['background_running','后台执行中']]){
  const card=operation('route_work',status),s=snapshot([card]);
  assert.equal(quietCoordination(card),false,status);
  const html=render(s);
  assert.ok(html.includes('class="turn-execution-details" aria-hidden="true" inert=""'),status);
  assert.ok(!html.includes('turn-progress-reply'),status);
  assert.ok(html.includes(label!),status+' must remain visible without opening raw records');
  assert.equal(liveTurnProgress([{id:card.id,at,card}])?.active,false,status);
  if(status==='pending')assert.equal(turnStatus(undefined,s.ai,[card],at,Date.parse(at)+5000).state,'等待确认');
 }
});
