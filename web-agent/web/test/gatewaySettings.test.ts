import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {Message} from '../../shared/contracts';
import {TranscriptMessage} from '../src/AIPanel';
import {GatewaySettings} from '../src/GatewaySettings';

const base:Message={id:'m1',sessionId:'channel',role:'user',text:'检查生产数据库磁盘',createdAt:'2026-11-14T00:00:00Z'};

test('external MCP instructions carry a visible origin badge; ordinary user messages do not',()=>{
  const external=renderToStaticMarkup(createElement(TranscriptMessage,{sessionId:'channel',message:{...base,external:{kind:'mcp'}}}));
  assert.match(external,/external-origin-badge/);assert.match(external,/外部 Agent/);assert.match(external,/检查生产数据库磁盘/);
  const ordinary=renderToStaticMarkup(createElement(TranscriptMessage,{sessionId:'channel',message:base}));
  assert.doesNotMatch(ordinary,/external-origin-badge/);assert.match(ordinary,/检查生产数据库磁盘/);
  const assistant:Message={id:'m2',sessionId:'channel',role:'assistant',text:'磁盘使用率 42%。',createdAt:'2026-11-14T00:00:05Z',external:{kind:'mcp'}};
  const reply=renderToStaticMarkup(createElement(TranscriptMessage,{sessionId:'channel',message:assistant}));
  assert.doesNotMatch(reply,/external-origin-badge/),'only external instructions (user role) show the badge';
});

test('gateway settings render their loading shell without a server connection',()=>{
  const html=renderToStaticMarkup(createElement(GatewaySettings,{onBusyChange:()=>{}}));
  assert.match(html,/外部研发 Agent 接入/);assert.match(html,/正在读取网关凭据…/);
});
