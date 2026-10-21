import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {AICard, AgentRun, SessionSnapshot} from '../../shared/contracts';
import type {TranscriptEntry} from '../src/timeline';
import {completedTurnInterimIds} from '../src/completedTurnProse';
import {AITranscript} from '../src/AIPanel';

const card = (id: string, type: string, content = id): TranscriptEntry => ({id, at: '2026-10-21T00:00:01Z', card: {id, at: '2026-10-21T00:00:01Z', type, content, status: 'completed'}});
const turn = [card('interim', 'message', '先核对测试节点。'), card('tool', 'operation'), card('final', 'message', '最终结果：测试服务正常。')];

test('completed tool turns archive only narration before the real final response', () => {
  assert.deepEqual([...completedTurnInterimIds(turn, true)], ['interim']);
  assert.equal(completedTurnInterimIds(turn, false).size, 0, 'live, failed, stopped and waiting turns keep partial prose');
  assert.equal(completedTurnInterimIds(turn.slice(0, 2), true).size, 0, 'no model final means no invented summary');
  assert.equal(completedTurnInterimIds([turn[0]!, turn[2]!], true).size, 0, 'ordinary conversation stays intact');
  assert.equal(completedTurnInterimIds([...turn, card('error', 'error')], true).size, 0, 'a later failure cannot be presented as completed');
  assert.equal(completedTurnInterimIds([...turn, {id:'role',at:'now',agentRun:{id:'role'} as AgentRun}], true).size, 0, 'role reports retain their own identity');
});

test('final prose keeps its stable entry; original narration remains available in folded records', () => {
  const cards = turn.map(entry => entry.card!) as AICard[];
  const snapshot = {session: {id: 'fixture'}, messages: [{id: 'user', role: 'user', text: '检查测试服务', createdAt: '2026-10-21T00:00:00Z'}], actions: [], ai: {status: 'completed', cards, cardsOffset: 0}} as unknown as SessionSnapshot;
  const html = renderToStaticMarkup(createElement(AITranscript, {snapshot}));
  assert.ok(html.includes('过程播报 · 1') && html.includes('先核对测试节点。'));
  assert.ok(html.includes('class="settled-reply is-archived" aria-hidden="true" inert=""'));
  assert.ok(html.includes('data-conversation-entry="final"'));
  assert.match(html, /class="settled-reply"><div class="settled-reply-content"><div data-conversation-entry="final"/);
  const live = renderToStaticMarkup(createElement(AITranscript, {snapshot: {...snapshot, ai: {...snapshot.ai!, status: 'running'}}}));
  assert.ok(!live.includes('is-archived') && !live.includes('过程播报 ·'));
  const activity = renderToStaticMarkup(createElement(AITranscript, {snapshot, mode: 'activity'}));
  assert.ok(!activity.includes('is-archived'));
});
