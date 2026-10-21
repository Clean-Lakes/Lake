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

test('one visual activity mark follows the current reply and remains during model waiting', () => {
  const s = snapshot();
  const html = render(s);
  assert.equal((html.match(/class="reply-activity"/g) ?? []).length, 1);
  assert.ok(html.indexOf('class="reply-activity"') > html.indexOf('正在核对测试数据。'));
  assert.ok(html.includes('class="reply-activity" aria-hidden="true"'));
  assert.equal((html.match(/aria-label="回答耗时"/g) ?? []).length, 1, 'metadata remains the single status owner');
  s.ai!.cards = [];
  assert.ok(hasActivity(render(s)), 'model waiting before its first text is still active');
});

test('finished, stopped, waiting, disconnected and historical views do not suggest ongoing generation', () => {
  for (const status of ['completed', 'failed', 'cancelled', 'interrupted', 'waiting_approval']) assert.ok(!hasActivity(render(snapshot(status))), status);
  const s = snapshot();
  assert.ok(!hasActivity(render(s, {disabled: true})));
  assert.ok(!hasActivity(render(s, {stopping: true})));
  assert.ok(!hasActivity(render(s, {mode: 'activity'})));
  assert.ok(!hasActivity(render(s, {mode: 'evidence'})));
  s.replyTimings = [{messageId: 'user', startedAt: at, finishedAt: '2026-10-21T00:00:02Z', status: 'completed'}];
  assert.ok(!hasActivity(render(s)), 'saved completion wins over a delayed running snapshot');
});

test('human questions and pending decisions suppress the reply activity, including role input', () => {
  const s = snapshot();
  s.ai!.question = {id: 'question', questions: []};
  assert.ok(!hasActivity(render(s)));
  s.ai!.question = undefined;
  s.ai!.cards.push({id: 'approval', type: 'operation', title: 'append', at, status: 'pending'});
  assert.ok(!hasActivity(render(s)));
  s.ai!.cards.pop();
  s.ai!.agentRuns = [{id:'role', sessionId:'fixture', rootTurnId:'turn', role:'host', task:'核对', resourceIds:[], createdAt:at, status:'waiting_input'}];
  assert.ok(!hasActivity(render(s)));
  s.ai!.agentRuns[0]!.rootTurnId = 'older-turn';
  assert.ok(hasActivity(render(s)), 'an earlier role question must not freeze this turn');
});
