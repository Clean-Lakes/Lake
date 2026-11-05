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
