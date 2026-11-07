import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement,Fragment} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {PilotWorkspace} from '../src/PilotWorkspace';
import {SidebarPilotEntry} from '../src/SidebarPilotEntry';
import type {SuperWorkspace} from '../../shared/contracts';

test('Pilot and real specialist instances replace session creation',()=>{
 const workspace:SuperWorkspace={active:true,project:{projectId:'project',routerSessionId:'pilot',version:1},workers:[{id:'orders-worker',roleId:'orders',roleName:'订单专员',sessionId:'orders-context',assignmentState:'parked',task:{taskId:'orders',sessionId:'orders-context',projectId:'project',title:'排查订单超时',state:'blocked',acceptanceState:'insufficient',revision:7,originRootTurnId:'actual-root',deadlineAt:'2026-11-03T00:00:00Z'}}]};
 const html=renderToStaticMarkup(createElement(Fragment,null,createElement(SidebarPilotEntry,{selected:true,onPilot(){}}),createElement(PilotWorkspace,{workspace,error:'',selectedId:'pilot',onPilot(){},onWorker(){}})));
 assert.match(html,/持续沟通，自动安排工作/);
 assert.match(html,/订单专员/);assert.match(html,/排查订单超时/);assert.match(html,/待核实/);
 assert.doesNotMatch(html,/新会话|新对话|已验收|项目执行范围|设置执行范围/);
 assert.match(html,/aria-current="page"/);
 assert.doesNotMatch(html,/brand\/lake-app-icon\.png/);
 assert.equal((html.match(/class="sidebar-pilot-entry/g)??[]).length,1);
 assert.doesNotMatch(html,/pilot-workspace-entry/);
});

test('an unavailable migration shows its actual reason without fake workers',()=>{
 const html=renderToStaticMarkup(createElement(PilotWorkspace,{workspace:null,error:'旧任务仍需核对',selectedId:null,onPilot(){},onWorker(){}}));
 assert.match(html,/旧任务仍需核对/);assert.doesNotMatch(html,/订单专员|创建成功/);
});

test('one durable role channel represents several independent task workers',()=>{
 const task=(id:string)=>({taskId:id,sessionId:`session-${id}`,title:`检查 ${id}`,state:'blocked' as const,acceptanceState:'insufficient' as const,revision:1,originRootTurnId:`root-${id}`,deadlineAt:'2026-11-04T00:00:00Z'});
 const workspace:SuperWorkspace={active:true,project:{projectId:'project',routerSessionId:'pilot',version:1},channels:[{id:'channel',projectId:'project',roleId:'ops',roleName:'运维专员',sessionId:'role-channel',revision:1,createdAt:'2026-11-03T00:00:00Z'}],workers:['a','b'].map(id=>({id,roleId:'ops',roleName:'运维专员',sessionId:`session-${id}`,task:task(id),assignmentState:'parked'}))};
 const html=renderToStaticMarkup(createElement(PilotWorkspace,{workspace,error:'',selectedId:'role-channel',onPilot(){},onWorker(){},onChannel(){}}));
 assert.equal((html.match(/class="nav-row pilot-worker-row/g)??[]).length,1);
 assert.match(html,/<small>1<\/small>/);
 assert.match(html,/aria-current="page"/);
});

test('a pending confirmation on the channel remains visible beside a newer completed task',()=>{
 const workspace:SuperWorkspace={active:true,project:{projectId:'p',routerSessionId:'pilot',version:1},channels:[{id:'ops',projectId:'p',roleId:'ops',roleName:'运维专员',sessionId:'channel',revision:1,createdAt:'',needsConfirmation:true}],workers:[]};
 const html=renderToStaticMarkup(createElement(PilotWorkspace,{workspace,error:'',selectedId:null,onPilot(){},onWorker(){}}));
 assert.match(html,/pilot-worker-confirmation/);assert.match(html,/>需确认<\/span>/);assert.match(html,/aria-label="运维专员 · 持续沟通 · 需确认"/);
 workspace.channels![0].needsConfirmation=false;
 assert.doesNotMatch(renderToStaticMarkup(createElement(PilotWorkspace,{workspace,error:'',selectedId:null,onPilot(){},onWorker(){}})),/pilot-worker-confirmation/);
});

test('a specialist created before any task is navigable with its persistent duties',()=>{
 const workspace:SuperWorkspace={active:true,project:{projectId:'p',routerSessionId:'pilot',version:1},channels:[{id:'channel-ops',projectId:'p',roleId:'stable-ops',roleName:'可靠性专员',duties:'只读核实主机证据',roleRevision:2,sessionId:'role-session',revision:1,createdAt:''}],workers:[]};
 const html=renderToStaticMarkup(createElement(PilotWorkspace,{workspace,error:'',selectedId:'role-session',onPilot(){},onWorker(){},onChannel(){}}));
 assert.equal((html.match(/class="nav-row pilot-worker-row/g)??[]).length,1);
 assert.match(html,/<small>1<\/small>/);assert.match(html,/可靠性专员/);assert.match(html,/只读核实主机证据/);assert.match(html,/aria-current="page"/);
 assert.doesNotMatch(html,/session-status-dot|已验收|正在执行/);
});
