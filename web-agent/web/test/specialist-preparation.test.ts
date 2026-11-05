import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {PilotWorkspace} from '../src/PilotWorkspace';
import type {SuperWorkspace} from '../../shared/contracts';

test('specialists show immediate preparation without claiming a leased execution',()=>{
 const workspace:SuperWorkspace={active:true,project:{projectId:'project',routerSessionId:'pilot',version:1},workers:[],channels:[{id:'channel',roleId:'role',projectId:'project',roleName:'数据库专员',sessionId:'channel-session',revision:1,createdAt:'',preparing:true}]};
 const render=()=>renderToStaticMarkup(createElement(PilotWorkspace,{workspace,error:'',selectedId:'pilot',onPilot(){},onWorker(){}}));
 const preparing=render();
 assert.match(preparing,/class="pilot-worker-running" role="img" aria-label="准备处理"/);
 assert.ok(!preparing.includes('aria-label="执行中"'));
 workspace.channels![0]!.running=true;
 assert.match(render(),/class="pilot-worker-running" role="img" aria-label="执行中"/);
 workspace.channels![0]!.running=false;workspace.channels![0]!.preparing=false;
 workspace.channels![0]!.needsConfirmation=true;
 const waiting=render();
 assert.ok(waiting.includes('需确认'));
 assert.ok(!waiting.includes('class="pilot-worker-running"'));
});

 test('a parked task without an actual question or approval does not advertise confirmation',()=>{
 const workspace={active:true,project:{projectId:'project',routerSessionId:'pilot',version:1},workers:[{id:'worker',roleId:'role',roleName:'主机专员',sessionId:'worker-session',createdAt:'',assignmentState:'parked',task:{taskId:'task',projectId:'project',sessionId:'worker-session',title:'读取主机',state:'waiting_user',acceptanceState:'insufficient'}}],channels:[{id:'channel',roleId:'role',projectId:'project',roleName:'主机专员',sessionId:'channel-session',revision:1,createdAt:'',needsConfirmation:false}]} as SuperWorkspace;
 const html=renderToStaticMarkup(createElement(PilotWorkspace,{workspace,error:'',selectedId:'channel-session',onPilot(){},onWorker(){}}));
 assert.ok(!html.includes('需确认')&&!html.includes('pilot-worker-confirmation'));
 });
