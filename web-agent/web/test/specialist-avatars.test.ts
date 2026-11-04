import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {SuperRoleAvatar} from '../src/SuperRoleAvatar';
import {PilotWorkspace} from '../src/PilotWorkspace';
import {ReplyIdentity} from '../src/ReplyIdentity';
import {SuperTaskInspector} from '../src/SuperTaskInspector';
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
test('local avatars render different silhouettes at existing dimensions without remote assets or status claims',()=>{
 const silhouettes=new Set<string>();
 for(let i=0;i<32;i++){
  const html=renderToStaticMarkup(createElement(SuperRoleAvatar,{roleId:`role-${i}`,name:'自定义专员',motion:'still',size:22}));
  silhouettes.add(appearance(html)[0][0]);
  assert.match(html,/width="22" height="22"/);assert.match(html,/data-motion="still"/);
  assert.doesNotMatch(html,/<img|https?:|已完成|处理中|已验收/);
 }
 assert.equal(silhouettes.size,8);
});
