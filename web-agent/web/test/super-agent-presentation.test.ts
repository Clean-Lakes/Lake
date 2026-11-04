import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {superTaskPresentation,superWorkerIcon} from '../src/superAgentPresentation';
import {PilotWorkspace} from '../src/PilotWorkspace';
import {SuperTaskInspector} from '../src/SuperTaskInspector';
import type {SuperTask,SuperWorker,SuperWorkspace,WorkGoal} from '../../shared/contracts';

test('specialist identities share Lake role shapes, with a stable investigation fallback',()=>{
 for(const [roleName,shape] of [['协调专员','coordinator'],['本机状态检查专员','investigator'],['代码修复专员','executor'],['前端依赖审查专员','verifier'],['Go 依赖审查专员','verifier'],['Deployment Specialist','executor'],['Independent Reviewer','verifier'],['自定义专员','investigator']])assert.equal(superWorkerIcon({roleName}),shape);
});

test('task success requires acceptance and distinct waiting/failure states stay visible',()=>{
 assert.deepEqual(superTaskPresentation({state:'completed',acceptanceState:'pass'}),{label:'已验收',tone:'success'});
 for(const acceptanceState of ['not_evaluated','insufficient','fail'] as const)assert.equal(superTaskPresentation({state:'completed',acceptanceState}).tone,'attention');
 for(const [state,tone] of [['waiting_user','attention'],['waiting_external','active'],['running','active'],['paused','neutral'],['failed','danger']] as const)assert.equal(superTaskPresentation({state,acceptanceState:'not_evaluated'}).tone,tone);
});

const task={taskId:'task',sessionId:'session',title:'只读检查依赖',state:'completed',acceptanceState:'pass',revision:1,originRootTurnId:'turn',deadlineAt:''} satisfies SuperTask;
const goal={items:[],modelRounds:1,roundLimit:10} as unknown as WorkGoal;
const worker={id:'worker',roleId:'opaque-role-id',roleName:'依赖审查专员',sessionId:'session',task,assignmentState:'completed'} satisfies SuperWorker;

test('navigation keeps task and status accessible while completed workers have no attention dot',()=>{
 const workspace={active:true,project:{projectId:'project',routerSessionId:'pilot',version:1},workers:[worker]} satisfies SuperWorkspace;
 const html=renderToStaticMarkup(createElement(PilotWorkspace,{workspace,error:'',selectedId:'session',onPilot(){},onWorker(){}}));
 assert.match(html,/aria-current="page" aria-label="依赖审查专员 · 只读检查依赖 · 已验收"/);
 assert.match(html,/data-role="coordinator"/);assert.match(html,/data-role="verifier"/);
 assert.doesNotMatch(html,/class="session-status-dot"/);
 const pending=renderToStaticMarkup(createElement(PilotWorkspace,{workspace:{...workspace,workers:[{...worker,task:{...task,state:'waiting_user',acceptanceState:'not_evaluated'}}]},error:'',selectedId:null,onPilot(){},onWorker(){}}));
 assert.match(pending,/需确认/);assert.match(pending,/pilot-worker-confirmation/);
});

test('inspector never attributes another session or task to the selected specialist',()=>{
 const render=(owner:SuperWorker)=>renderToStaticMarkup(createElement(SuperTaskInspector,{task,goal,worker:owner}));
 assert.match(render(worker),/依赖审查专员/);
 assert.doesNotMatch(render({...worker,sessionId:'another-session'}),/依赖审查专员/);
 assert.doesNotMatch(render({...worker,task:{...task,taskId:'another-task'}}),/依赖审查专员/);
});

test('opening the details of a paused task before its first plan shows the empty state',()=>{
 const html=renderToStaticMarkup(createElement(SuperTaskInspector,{task:{...task,state:'paused'},goal:{...goal,items:null}}));
 assert.match(html,/专员生成计划后会显示在这里/);
});
