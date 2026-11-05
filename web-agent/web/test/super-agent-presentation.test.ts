import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {superTaskPresentation,superWorkerAppearance,superWorkerIcon,superAvatarMotion} from '../src/superAgentPresentation';
import {PilotWorkspace} from '../src/PilotWorkspace';
import {SuperTaskInspector} from '../src/SuperTaskInspector';
import type {SpecialistChannelInfo,SuperTask,SuperWorker,SuperWorkspace,WorkGoal} from '../../shared/contracts';

test('specialist appearances follow stable RoleID rather than mutable names or tasks',()=>{
 const before=superWorkerAppearance({roleId:'stable-role',roleName:'数据库专员'});
 assert.deepEqual(superWorkerAppearance({roleId:'stable-role',roleName:'改名后的发布专员'}),before);
 const shapes=new Set(Array.from({length:10000},(_,i)=>superWorkerIcon({roleId:`role-${i}`,roleName:'专员'})));
 assert.equal(shapes.size,100);
 assert.notEqual(superWorkerIcon({roleName:'数据库专员'}),superWorkerIcon({roleName:'发布专员'}));
 assert.equal(superAvatarMotion(true,'blocked'),'working');
 for(const state of ['paused','blocked','failed','cancelled'] as const)assert.equal(superAvatarMotion(false,state),'still');
 assert.equal(superAvatarMotion(false,'completed'),'idle');assert.equal(superAvatarMotion(false),'idle');
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
 assert.match(html,/data-role="coordinator"/);assert.ok(html.includes(`data-role="${superWorkerIcon(worker)}"`));
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

test('specialist sidebar prioritizes live execution, keeps confirmations and clears only viewed completions', () => {
 const channel: SpecialistChannelInfo = {
  id: 'channel', sessionId: 'role-channel', projectId: 'project', roleId: worker.roleId,
  roleName: worker.roleName, createdAt: '', revision: 1,
 };
 const earlier = '00000000000000000008', latest = '00000000000000000009';
 function render(fields: Partial<SpecialistChannelInfo>, selectedId: string | null = null, selectedRoleId?: string) {
  const workspace: SuperWorkspace = {
   active: true, project: {projectId: 'project', routerSessionId: 'pilot', version: 1},
   // A paused preview in the bounded worker list must not decide this role's aggregate activity.
   workers: [{...worker, task: {...task, state: 'paused'}}], channels: [{...channel, ...fields}],
  };
  return renderToStaticMarkup(createElement(PilotWorkspace, {workspace, selectedId, selectedRoleId, error: '', onPilot(){}, onWorker(){}}));
 }
 const unread = {completionCursor: latest, seenCompletionCursor: earlier, needsConfirmation: true};
 const executing = render({...unread, running: true});
 assert.match(executing, /class="pilot-worker-running"/);
 assert.match(executing, /activity-indicator/);
 assert.match(executing, /class="pilot-worker-confirmation"/);
 assert.doesNotMatch(executing, /class="pilot-worker-unread"/);

 const finished = render(unread);
 assert.match(finished, /class="pilot-worker-unread"/);
 assert.match(finished, /class="pilot-worker-confirmation"/);
 for (const html of [
  render({}), render({...unread, seenCompletionCursor: latest}),
  render(unread, channel.sessionId), render(unread, worker.sessionId),
  render(unread, 'older-session-outside-worker-preview', worker.roleId),
 ]) assert.doesNotMatch(html, /class="(?:pilot-worker-unread|pilot-worker-running|session-status-dot)"/);
 assert.match(render(unread, 'pilot'), /class="pilot-worker-unread"/);
});
