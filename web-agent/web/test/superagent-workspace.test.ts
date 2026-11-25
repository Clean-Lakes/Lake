import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {PilotWorkspace} from '../src/PilotWorkspace';
import {ChatGroupNavigation} from '../src/ChatGroup';
import type {SuperWorkspace} from '../../shared/contracts';

test('the project group list and the specialist rail have distinct entries',()=>{
 const channel={id:'channel-ops',projectId:'p',roleId:'ops',roleName:'运维专员',sessionId:'ops-channel',revision:1,createdAt:'',messageRead:{cursor:'2',seenCursor:'1'}};
 const workspace:SuperWorkspace={active:true,project:{projectId:'p',routerSessionId:'pilot',version:1},workers:[],channels:[channel]};
 const props={workspace,error:'',selectedId:'group',showHeading:false,onPilot(){},onWorker(){},onChannel(){}};
 const rail=renderToStaticMarkup(createElement(PilotWorkspace,{...props,presentation:'rail'}));
 assert.match(rail,/sidebar-rail-button sidebar-specialist-button/);
 assert.match(rail,/title="运维专员.*有新消息未读"/);
 assert.doesNotMatch(rail,/sidebar-pilot-entry|<strong>运维专员<\/strong>/);
 const entry=renderToStaticMarkup(createElement(PilotWorkspace,{...props,presentation:'entry'}));
 assert.match(entry,/sidebar-pilot-entry/);
 assert.doesNotMatch(entry,/运维专员/);
 const groups=renderToStaticMarkup(createElement(ChatGroupNavigation,{projectId:'p',channels:[channel],selectedId:'group',disabled:false,
  groups:[{sessionId:'group',projectId:'p',title:'运维协作群',updatedAt:'',members:[channel],latest:{text:'已更新巡检记录',author:'运维专员'}}],
  onOpen(){},async onCreated(){}}));
 assert.match(groups,/aria-label="新建群组"/);
 assert.match(groups,/class="nav-row chat-group-nav-row" aria-current="page"/);
 assert.match(groups,/运维专员：已更新巡检记录/);
});

test('Pilot and real specialist instances replace session creation',()=>{
 const workspace:SuperWorkspace={active:true,project:{projectId:'project',routerSessionId:'pilot',version:1},workers:[{id:'orders-worker',roleId:'orders',roleName:'订单专员',sessionId:'orders-context',assignmentState:'parked',task:{taskId:'orders',sessionId:'orders-context',projectId:'project',title:'排查订单超时',state:'blocked',acceptanceState:'insufficient',revision:7,originRootTurnId:'actual-root',deadlineAt:'2026-11-03T00:00:00Z'}}]};
 const html=renderToStaticMarkup(createElement(PilotWorkspace,{workspace,error:'',selectedId:'pilot',onPilot(){},onWorker(){}}));
 assert.match(html,/>打开对话<\/span>/);
 assert.match(html,/订单专员/);assert.match(html,/排查订单超时/);assert.match(html,/已暂停/);
 assert.doesNotMatch(html,/新会话|新对话|已验收|项目执行范围|设置执行范围/);
 assert.match(html,/aria-current="page"/);
 assert.doesNotMatch(html,/brand\/lake-app-icon\.png/);
 assert.equal((html.match(/class="nav-row sidebar-pilot-entry/g)??[]).length,1);
 assert.ok(html.indexOf('>专员<')<html.indexOf('>Lake<')&&html.indexOf('>Lake<')<html.indexOf('>订单专员<'));
 assert.match(html,/<small>2<\/small>/);
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
 assert.match(html,/<small>2<\/small>/);
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
 assert.match(html,/<small>2<\/small>/);assert.match(html,/可靠性专员/);assert.match(html,/只读核实主机证据/);assert.match(html,/aria-current="page"/);
 assert.doesNotMatch(html,/session-status-dot|已验收|正在执行/);
});

test('the built-in Pilot remains available during initial workspace activation and preserves actual errors',()=>{
 const html=renderToStaticMarkup(createElement(PilotWorkspace,{workspace:null,error:'仍在核对旧记录',selectedId:null,pilotDisabled:true,onPilot(){},onWorker(){}}));
 assert.match(html,/Lake · 打开对话 · 内置专员/);assert.match(html,/<small>1<\/small>/);assert.match(html,/仍在核对旧记录/);
 assert.match(html,/<button[^>]+class="nav-row sidebar-pilot-entry"[^>]+disabled/);
 assert.doesNotMatch(html,/aria-current|删除专员|aria-haspopup/);
});
