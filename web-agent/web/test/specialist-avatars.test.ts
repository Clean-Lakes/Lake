import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {SpecialistAvatarProvider,SuperRoleAvatar} from '../src/SuperRoleAvatar';
import {superWorkerAppearance} from '../src/superAgentPresentation';
import {PilotWorkspace} from '../src/PilotWorkspace';
import {ReplyIdentity} from '../src/ReplyIdentity';
import {SuperTaskInspector} from '../src/SuperTaskInspector';
import {lakeAvatarCatalog} from '../src/lakeAvatarCatalog';
import {AgentIcon} from '../src/AgentIcon';
import type {SuperWorkspace,SuperWorker,WorkGoal} from '../../shared/contracts';

function appearance(html:string){
 const avatars=[...html.matchAll(/class="super-role-avatar" data-role="([^"]+)" data-palette="([^"]+)" data-variant="([^"]+)"/g)];
 return avatars.filter(match=>match[1]!=='coordinator').map(match=>match.slice(1,4));
}
test('the same role has one appearance before its first task, after rename, in reports and in task details',()=>{
 const channel={id:'channel',projectId:'p',roleId:'stable-database-role',roleName:'数据库专员',sessionId:'channel-session',revision:1,createdAt:''};
 const workspace:SuperWorkspace={active:true,project:{projectId:'p',routerSessionId:'pilot',version:1},channels:[channel],workers:[]};
 const renderNav=()=>renderToStaticMarkup(createElement(PilotWorkspace,{workspace,error:'',selectedId:null,onPilot(){},onWorker(){}}));
 const initial=renderNav(),expected=appearance(initial);
 assert.equal(expected.length,1);assert.doesNotMatch(initial,/pilot-worker-running/);
 channel.roleName='改名后的数据核对专员';
 assert.deepEqual(appearance(renderNav()),expected);
 const task={taskId:'task',sessionId:'worker-session',title:'A new task',state:'completed' as const,acceptanceState:'pass' as const,revision:1,originRootTurnId:'turn',deadlineAt:''};
 const worker:SuperWorker={id:'worker',roleId:channel.roleId,roleName:channel.roleName,sessionId:task.sessionId,assignmentState:'parked',task};
 const report=renderToStaticMarkup(createElement(ReplyIdentity,{identity:{name:'Pilot',pilot:true},author:{kind:'specialist',name:channel.roleName,roleId:channel.roleId,workerId:worker.id,sessionId:worker.sessionId,taskId:task.taskId}}));
 const detail=renderToStaticMarkup(createElement(SuperTaskInspector,{task,worker,goal:{items:[],modelRounds:1,roundLimit:10} as unknown as WorkGoal}));
 assert.deepEqual(appearance(report),expected);assert.deepEqual(appearance(detail),expected);
 assert.deepEqual(appearance(renderToStaticMarkup(createElement(SuperRoleAvatar,{roleId:channel.roleId,name:channel.roleName}))),expected);
});
test('all 100 local avatars have unique geometry at existing dimensions, independent of colour and labels',()=>{
 const silhouettes=new Set<string>();
 assert.equal(lakeAvatarCatalog.length,100);
 assert.equal(new Set(lakeAvatarCatalog.map(row=>row.id)).size,100);
 assert.equal(new Set(lakeAvatarCatalog.map(row=>row.name)).size,100);
 for(const avatar of lakeAvatarCatalog){
  const html=renderToStaticMarkup(createElement(AgentIcon,{role:avatar.id,size:22}));
  silhouettes.add(html.replace(/^<svg[^>]+>/,'').replaceAll(/class="[^"]*"/g,''));
  assert.match(html,/width="22" height="22"/);
  assert.doesNotMatch(html,/<img|https?:|已完成|处理中|已验收/);
  assert.doesNotMatch(html,/NaN|undefined|Infinity/);
 }
 assert.equal(silhouettes.size,100);
});

test('an explicit project avatar reaches navigation, reports and task details without changing role identity',()=>{
 const channel={id:'channel',projectId:'p',roleId:'stable-role',roleName:'牛马专员',sessionId:'channel-session',revision:1,createdAt:'',avatarId:'beaver' as const};
 const task={taskId:'task',sessionId:'worker-session',title:'原任务',state:'completed' as const,acceptanceState:'pass' as const,revision:1,originRootTurnId:'turn',deadlineAt:''};
 const worker:SuperWorker={id:'worker',roleId:channel.roleId,roleName:channel.roleName,sessionId:task.sessionId,assignmentState:'parked',task};
 const workspace:SuperWorkspace={active:true,project:{projectId:'p',routerSessionId:'pilot',version:1},channels:[channel],workers:[worker]};
 const content=createElement('div',null,
  createElement(PilotWorkspace,{workspace,error:'',selectedId:channel.sessionId,onPilot(){},onWorker(){}}),
  createElement(ReplyIdentity,{identity:{name:'Pilot',pilot:true},author:{kind:'specialist',name:channel.roleName,roleId:channel.roleId,workerId:worker.id,sessionId:worker.sessionId,taskId:task.taskId}}),
  createElement(SuperTaskInspector,{task,worker,goal:{items:[],modelRounds:1} as unknown as WorkGoal}),
  createElement(SuperRoleAvatar,{pilot:true,roleId:channel.roleId}));
 const render=(channels:typeof workspace.channels)=>renderToStaticMarkup(createElement(SpecialistAvatarProvider,{channels,children:content}));
 const before=JSON.stringify(worker),html=render([channel]),looks=appearance(html);
 assert.ok(looks.length>=3);assert.ok(looks.every(look=>look[0]==='beaver'));
 assert.match(html,/data-role="coordinator"/);assert.equal(JSON.stringify(worker),before);
 const defaultLook=superWorkerAppearance(worker);
 assert.ok(appearance(render([])).every(look=>look[0]===defaultLook.icon),'switching projects cannot leak a previous avatar override');
 assert.ok(appearance(render([{...channel,avatarId:'https://invalid.example' as any}])).every(look=>look[0]===defaultLook.icon));
 assert.equal(superWorkerAppearance({...worker,avatarId:'unknown'}).icon,defaultLook.icon);
 assert.deepEqual({...superWorkerAppearance({...worker,avatarId:'beaver'}),icon:defaultLook.icon},defaultLook,'explicit selection preserves the stable phase, palette and variant');
});
