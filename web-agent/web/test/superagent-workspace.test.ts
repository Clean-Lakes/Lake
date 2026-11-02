import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {PilotWorkspace} from '../src/PilotWorkspace';
import type {SuperWorkspace} from '../../shared/contracts';

test('Pilot and real specialist instances replace session creation',()=>{
 const workspace:SuperWorkspace={active:true,project:{projectId:'project',routerSessionId:'pilot',version:1},workers:[{id:'orders-worker',roleId:'orders',roleName:'订单专员',sessionId:'orders-context',assignmentState:'parked',task:{taskId:'orders',sessionId:'orders-context',projectId:'project',title:'排查订单超时',state:'blocked',acceptanceState:'insufficient',revision:7,originRootTurnId:'actual-root',deadlineAt:'2026-11-03T00:00:00Z'}}]};
 const html=renderToStaticMarkup(createElement(PilotWorkspace,{workspace,error:'',selectedId:'pilot',onPilot(){},onWorker(){}}));
 assert.match(html,/持续沟通，自动安排工作/);
 assert.match(html,/订单专员/);assert.match(html,/排查订单超时/);assert.match(html,/待核实/);
 assert.doesNotMatch(html,/新会话|新对话|已验收/);
 assert.match(html,/aria-current="page"/);
 assert.match(html,/data-role="coordinator"/);
 assert.match(html,/sre-avatar-coordinator/);
});

test('an unavailable migration shows its actual reason without fake workers',()=>{
 const html=renderToStaticMarkup(createElement(PilotWorkspace,{workspace:null,error:'旧任务仍需核对',selectedId:null,onPilot(){},onWorker(){}}));
 assert.match(html,/旧任务仍需核对/);assert.doesNotMatch(html,/订单专员|创建成功/);
});
