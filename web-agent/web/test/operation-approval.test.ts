import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {AIApproval,AIView} from '../../shared/contracts';
import {AIPending} from '../src/AIPanel';
const pending:AIApproval={id:'target-fixture',kind:'resource_select',risk:'readonly',target:'演示服务器',resourceId:'private-target-id',terminalId:'private-terminal',fingerprint:'fixture',needsTerminal:true,call:{id:'target-call',name:'inspect_host',arguments:'{"runtime":"ssh","asset_ref":"private-alias"}'}};
const render=(patch:Partial<AIApproval>={},extra={})=>renderToStaticMarkup(createElement(AIPending,{session:'fixture',view:{pending:{...pending,...patch},pendingApprovals:[pending,pending]} as AIView,refresh:async()=>{},...extra}));
test('resource selection uses neutral review with visible target and terminal effect, technical IDs collapsed',()=>{
 const html=render();
 for(const text of ['operation-approval','确认本次操作的目标资源','演示服务器','为此资源创建终端后继续','使用此资源并创建终端','2 项操作待确认','尚未执行'])assert.ok(html.includes(text),text);
 for(const text of ['class="ai-pending"','private-target-id','private-terminal','private-alias','<details open'])assert.ok(!html.includes(text),text);
 assert.ok(render({needsTerminal:false}).includes('>使用此资源</button>'));
});
test('generic commands and SQL retain full execution text; dangerous and typed confirmation remain enforced',()=>{
 const html=render({kind:'command',risk:'dangerous',confirmation:'执行 演示服务器',call:{...pending.call,name:'shell',arguments:JSON.stringify({command:'printf "<test>"'})}},{runId:'child',agentName:'调查员'});
 for(const text of ['完整命令','printf','&lt;test&gt;','高风险','执行 演示服务器','调查员'])assert.ok(html.includes(text),text);
 assert.ok(/disabled=""[^>]*>确认并继续/.test(html));
 assert.ok(!html.includes('2 项操作待确认'),'child has independent queue');
 assert.ok(render({kind:'readonly_sql',call:{...pending.call,name:'sql',arguments:'{"sql":"SELECT 1"}'}}).includes('SELECT 1'));
});
test('terminal creation and unknown approval types use modern fallback and preserve explicit review',()=>{
 assert.ok(render({kind:'terminal_open'}).includes('>允许创建并继续</button>'));
 assert.ok(render({kind:'future_kind',call:{...pending.call,arguments:'invalid'}}).includes('技术参数'));
});
