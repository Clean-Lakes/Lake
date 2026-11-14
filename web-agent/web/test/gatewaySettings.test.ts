import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {Message} from '../../shared/contracts';
import {TranscriptMessage} from '../src/AIPanel';
import {GatewaySettings} from '../src/GatewaySettings';
import {SpecialistTaskList} from '../src/SpecialistTaskList';

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

test('task rows mark work that arrived from an external agent',()=>{
  const worker:import('../../shared/contracts').SuperWorker={id:'w1',roleId:'r',roleName:'数据库专员',sessionId:'sw1',sourceExternal:true,
    task:{taskId:'st1',sessionId:'sw1',title:'检查本机当前时间与磁盘剩余空间',state:'completed',acceptanceState:'pass',revision:1,originRootTurnId:'t1',deadlineAt:'2026-11-14T01:30:00Z'},assignmentState:'parked'};
  const list=renderToStaticMarkup(createElement(SpecialistTaskList,{channel:{id:'c',sessionId:'sc',projectId:'p',roleId:'r',roleName:'数据库专员',revision:1,createdAt:'2026-11-14T00:00:00Z'},rows:[{worker,progress:null,agent:'Lake Worker',members:[],moving:false,updatedAt:'2026-11-14T00:10:00Z'}],connected:false,onTask:()=>{}}));
  assert.match(list,/external-origin-badge/);assert.match(list,/外部 Agent/);
});
