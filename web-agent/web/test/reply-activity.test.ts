import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {SessionSnapshot} from '../../shared/contracts';
import {AITranscript} from '../src/AIPanel';

const at = '2026-10-21T00:00:00Z';
const snapshot = (status = 'running'): SessionSnapshot => ({
  session: {id: 'fixture'}, messages: [{id: 'user', role: 'user', text: '检查测试服务', createdAt: at}], resources: [], actions: [],
  ai: {session: 'fixture', status, rootTurnId: 'turn', cardsOffset: 0, cards: [{id: 'reply', at, type: 'message', status: status === 'running' ? 'running' : 'completed', content: '正在核对测试数据。'}]},
} as unknown as SessionSnapshot);
const render = (s: SessionSnapshot, props = {}) => renderToStaticMarkup(createElement(AITranscript, {snapshot: s, ...props}));
const hasActivity = (html: string) => html.includes('class="reply-activity"');

test('normal replies and model waiting keep status metadata without a blue loading glyph',()=>{
 const s=snapshot();
 assert.equal(hasActivity(render(s)),false);
 assert.ok(render(s).includes('正在核对测试数据。'));
 assert.equal((render(s).match(/aria-label="回答耗时"/g)??[]).length,1);
 s.ai!.cards=[];assert.equal(hasActivity(render(s)),false);
 for(const status of ['completed','failed','cancelled','waiting_approval'])assert.equal(hasActivity(render(snapshot(status))),false);
});

test('resource execution and streamed final prose have neither an overall row nor a loading mark',()=>{
 const s=snapshot();s.resources=[{id:'pg',name:'数据库',kind:'database'},{id:'cache',name:'缓存',kind:'redis'}] as SessionSnapshot['resources'];
 s.ai!.cards.unshift(...s.resources.map(r=>({id:'op-'+r.id,type:'operation',title:'query_sql',status:'completed',at,data:{resource_id:r.id,target:r.name}})));
 for(const status of ['running','completed']){
  s.ai!.status=status;const html=render(s);
  assert.ok(html.includes('数据库')&&html.includes('缓存'));
  assert.ok(html.includes('正在核对测试数据。'));
  assert.equal(hasActivity(html),false);assert.ok(!html.includes('aria-label="本轮进度"'));
 }
});
