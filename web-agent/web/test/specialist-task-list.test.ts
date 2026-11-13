import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {SessionSnapshot,SpecialistChannelEntry,SuperWorker,Resource,ResourceTreeNode,TaskCollaboration,TaskParticipant} from '../../shared/contracts';
import {filterSpecialistTasks,specialistResourcePaths,specialistTaskMembers,specialistTaskRows,specialistTaskTime} from '../src/specialistTaskListModel';
import {SpecialistTaskList} from '../src/SpecialistTaskList';
import {ConversationReadButton} from '../src/ConversationReadMarker';
import {TaskSpecialistAvatars} from '../src/TaskSpecialistAvatars';
import {SpecialistAvatarProvider} from '../src/SuperRoleAvatar';

const at='2026-11-11T01:00:00Z';
const worker=(id:string,state:SuperWorker['task']['state']='running'):SuperWorker=>({id,sessionId:`session-${id}`,roleId:'ops',roleName:'服务器专员',createdAt:at,assignmentState:state==='running'?'active':'parked',task:{taskId:`task-${id}`,sessionId:`session-${id}`,projectId:'project',title:'同名检查任务',state,acceptanceState:state==='completed'?'pass':'not_evaluated',revision:1,originRootTurnId:'root',deadlineAt:'',updatedAt:at,resources:[{runtime:'ssh',assetRef:'host'}]},execution:{backend:{kind:'acp',agent:'codex',revision:2},assignedAt:at,source:'task_assignment',runs:[],totalRuns:0}});
const resource={id:'host',projectId:'project',name:'应用节点',kind:'ssh',status:'available',description:'private-description',ssh:{host:'private-host',username:'private-user',credentialRef:'private-ref'}} as Resource;
const node=(id:string,name:string,parentId:string|null=null,resourceId:string|null=null):ResourceTreeNode=>({id,name,parentId,resourceId,projectId:'project',kind:resourceId?'resource':'folder',position:0});
const tree=[node('root','演示环境'),node('cluster','业务集群','root'),node('leaf','应用节点','cluster','host')];
const source={projectId:'project',resources:[resource],resourceTree:tree};
const participant=(roleId:string,state:TaskParticipant['state']='running'):TaskParticipant=>({roleId,roleName:'同名专员',workerId:`worker-${roleId}`,sessionId:`session-${roleId}`,state,contributed:false});
const collaboration=(participants:TaskParticipant[]):TaskCollaboration=>({participants,state:'running',acceptanceState:'not_evaluated'});

test('a paused channel keeps its task records without claiming normal navigation is an outage',()=>{
 const channel={id:'channel',sessionId:'channel',projectId:'project',roleId:'ops',roleName:'服务器专员',revision:1,createdAt:at,messageRead:{cursor:'00000000000000000002',seenCursor:''}};
 const rows=specialistTaskRows({...source,workers:[worker('saved','completed')]});
 const render=(error='',loading=false)=>renderToStaticMarkup(createElement(SpecialistTaskList,{channel,rows,onTask(){},connected:false,loading,error,onRetry(){}}));
 for(const loading of [false,true]){
  const html=render('',loading);
  assert.match(html,/data-task-id="task-saved"/,'cached history remains available');
  assert.doesNotMatch(html,/specialist-page-error|连接已断开|正在重连|role="alert"/);
  assert.match(html,/<button[^>]*disabled=""[^>]*>.*?标记已读/s,'read receipts stay disabled until this channel is ready');
 }
 const failed=render('任务读取失败（HTTP 503）');
 assert.match(failed,/role="alert"/);assert.match(failed,/任务读取失败（HTTP 503）/);assert.match(failed,/>重新获取<\/button>/);
 assert.match(failed,/data-task-id="task-saved"/,'a real fetch failure does not discard history');
});

test('single tasks reserve one stable identity without inventing collaborators',()=>{
 const own=worker('solo'),before=JSON.stringify(own),members=specialistTaskMembers(own,true);
 assert.deepEqual(members,[{key:'role:ops',roleId:'ops',name:own.roleName,moving:true}]);
 assert.equal(JSON.stringify(own),before);
 const html=renderToStaticMarkup(createElement(TaskSpecialistAvatars,{members,descriptionId:'solo-members'}));
 assert.equal((html.match(/class="super-role-avatar"/g)??[]).length,1);
 assert.doesNotMatch(html,/data-multiple|task-specialist-overflow/);
 assert.match(html,/id="solo-members">参与专员：服务器专员/);
});

test('collaboration avatars use exact role identities, not names or participant ordering',()=>{
 const own=worker('own'),a=participant('a','completed'),b=participant('b'),before=JSON.stringify([own,a,b]);
 const members=specialistTaskMembers(own,false,collaboration([b,a,{...b,workerId:'second-b',sessionId:'second-b',state:'paused'},{...participant('ops'),workerId:own.id,sessionId:own.sessionId}]));
 assert.deepEqual(members.map(member=>member.key),['role:ops','role:a','role:b']);
 assert.deepEqual(members.map(member=>member.moving),[false,false,true]);
 assert.equal(members[1].name,members[2].name,'same-name specialists stay separate');
 assert.deepEqual(specialistTaskMembers(own,false,collaboration([a,b])),members);
 assert.equal(JSON.stringify([own,a,b]),before);
 const legacy={...own,roleId:''},legacyA={...a,roleId:''},legacyB={...b,roleId:''};
 assert.deepEqual(specialistTaskMembers(legacy,false,collaboration([legacyA,legacyB])).map(member=>member.key),['worker:own','worker:worker-a','worker:worker-b']);
});

test('a shared task keeps each specialist animation independent after the owner stops',()=>{
 const own=worker('owner','completed');
 own.task.collaboration=collaboration([participant('running'),participant('waiting','waiting_user'),{...participant('submitted'),contributed:true}]);
 const row=specialistTaskRows({...source,workers:[own]})[0];
 assert.equal(row.moving,false);
 assert.deepEqual(row.members.filter(member=>member.moving).map(member=>member.roleId),['running']);
});

test('only a snapshot bound to this project, task and execution can supply newer members',()=>{
 const own=worker('owner');own.task.collaboration=collaboration([participant('old')]);
 const snapshot={session:{id:own.sessionId,projectId:'project'},superagent:{task:{...own.task,collaboration:collaboration([participant('new')])}}} as SessionSnapshot;
 const members=(active:SessionSnapshot[])=>specialistTaskRows({...source,workers:[own],active})[0].members.map(member=>member.roleId);
 assert.deepEqual(members([snapshot]),['ops','new']);
 assert.deepEqual(members([{...snapshot,session:{...snapshot.session,projectId:'other'}}]),['ops','old']);
 assert.deepEqual(members([{...snapshot,session:{...snapshot.session,id:'other'}}]),['ops','old']);
 assert.deepEqual(members([{...snapshot,superagent:{...snapshot.superagent!,task:{...snapshot.superagent!.task,taskId:'other'}}}]),['ops','old']);
});

test('compact avatar groups cap visible portraits and keep every name accessible offline',()=>{
 const own=worker('owner');own.task.collaboration=collaboration(['a','b','c','d','e'].map(id=>participant(id)));
 const members=specialistTaskMembers(own,true);
 const channels=[{id:'a-channel',sessionId:'a-channel',projectId:'project',roleId:'a',roleName:'同名专员',revision:1,createdAt:at,avatarId:'beaver' as const}];
 const html=renderToStaticMarkup(createElement(SpecialistAvatarProvider,{channels,children:createElement(TaskSpecialistAvatars,{members,descriptionId:'team-members',connected:false})}));
 assert.equal((html.match(/class="super-role-avatar"/g)??[]).length,3);
 assert.match(html,/task-specialist-overflow">\+3</);assert.match(html,/data-role="beaver"/);
 assert.doesNotMatch(html,/data-motion="working"|<button/);
 assert.match(html,/id="team-members">参与专员：服务器专员、同名专员、同名专员、同名专员、同名专员、同名专员/);
 const list=renderToStaticMarkup(createElement(SpecialistTaskList,{channel:channels[0],rows:specialistTaskRows({...source,workers:[own]}),onTask(){}}));
 assert.match(list,/data-collaborative="true"/);assert.match(list,/aria-describedby="[^"]+-owner"/);
 assert.match(list,/aria-label="查看任务：同名检查任务"/);
});

test('task rows retain exact identities, Lake role avatars and frozen executor bindings',()=>{
 const a=worker('a'),b=worker('b','completed');b.execution=undefined;b.createdAt='2026-11-10T01:00:00Z';
 const before=JSON.stringify([a,b]);
 const rows=specialistTaskRows({...source,workers:[a,b]});
 assert.equal(rows.length,2);assert.equal(rows[0].worker.sessionId,'session-a');assert.equal(rows[1].worker.sessionId,'session-b');
 assert.equal(rows[0].agent,'Codex');assert.equal(rows[1].agent,'Lake Worker');
 assert.equal(rows[0].progress,undefined,'missing progress cannot become an invented percentage');
 assert.deepEqual(rows[0].paths,['演示环境 / 业务集群 / 应用节点']);
 const html=renderToStaticMarkup(createElement(SpecialistTaskList,{channel:{id:'channel',sessionId:'channel',projectId:'project',roleId:'ops',roleName:'服务器专员',revision:1,createdAt:at},rows,selectedSessionId:'session-b',onTask:()=>{}}));
 assert.match(html,/aria-label="专员任务列表"/);assert.match(html,/aria-current="true"/);assert.match(html,/data-task-id="task-a"/);assert.match(html,/data-task-id="task-b"/);
 assert.match(html,/openai.svg/);assert.match(html,/super-role-avatar/);assert.match(html,/未报告/);assert.doesNotMatch(html,/private-host|private-user|private-ref|private-description/);
 assert.equal(JSON.stringify([a,b]),before);
});

test('live animation follows the exact task instead of an external answer or sibling question',()=>{
 const done=worker('done','completed');done.task.acceptanceState='insufficient';
 const stopped=worker('stopped','cancelled'),waiting=worker('waiting','running'),active=worker('active');waiting.activity={phase:'waiting_approval',label:'等待确认',updatedAt:at};
 active.execution!.runs=[{id:'answered',agent:'codex',scope:'worker',state:'completed',dispatchPhase:'answered',createdAt:at,updatedAt:at,usage:null,summary:'外部自报完成'}];
 const rows=specialistTaskRows({...source,workers:[done,stopped,waiting,active]});
 const byId=(id:string)=>rows.find(row=>row.worker.id===id)!;
 assert.equal(byId('done').moving,false);assert.equal(byId('waiting').moving,false);assert.equal(byId('active').moving,true);
 assert.equal(byId('stopped').moving,false);
});

test('progress only consumes the exact task snapshot or its recorded successful TodoWrite',()=>{
 const a=worker('a','blocked'),b=worker('b');
 const snapshot={session:{id:a.sessionId,projectId:'project'},superagent:{task:a.task,goal:{items:[{status:'completed'},{status:'running'}]}},ai:{cards:[]}} as unknown as SessionSnapshot;
 const entry=(id:string,taskId:string,status='completed'):SpecialistChannelEntry=>({id,sourceSessionId:b.sessionId,taskId:b.task.taskId,createdAt:at,card:{id,type:'operation',title:'TodoWrite',at,status,content:JSON.stringify({todos:[{content:'步骤一',status:'completed'},{content:'步骤二',status:'in_progress'},{content:'步骤三',status:'pending'}]}),data:{taskId}}});
 let rows=specialistTaskRows({...source,workers:[a,b],active:[snapshot],entries:[entry('valid',b.task.taskId),entry('wrong','other-task'),entry('failed',b.task.taskId,'failed')]});
 assert.deepEqual(rows.find(row=>row.worker.id==='a')!.progress,{completed:1,total:2});
 assert.deepEqual(rows.find(row=>row.worker.id==='b')!.progress,{completed:1,total:3});
 rows=specialistTaskRows({...source,workers:[b],active:[{...snapshot,session:{...snapshot.session,id:b.sessionId}}]});
 assert.equal(rows[0].progress,undefined,'a sibling task snapshot cannot supply progress');
});

test('directory search uses only visible project metadata and tolerates broken legacy parents',()=>{
 const foreign={...resource,id:'foreign',projectId:'foreign',name:'other-project'};
 const paths=specialistResourcePaths('project',[resource,foreign],[...tree,{...node('foreign-folder','secret'),projectId:'foreign'}]);
 assert.equal(paths.has('foreign'),false);assert.equal(paths.get('host'),'演示环境 / 业务集群 / 应用节点');
 const rows=specialistTaskRows({...source,workers:[worker('a')]});
 assert.equal(filterSpecialistTasks(rows,'业务集群').length,1);assert.equal(filterSpecialistTasks(rows,'ＣＯＤＥＸ').length,1);
 assert.equal(filterSpecialistTasks(rows,'演示环境/业务集群').length,1);
 assert.equal(filterSpecialistTasks(rows,'other-project').length,0);
 const broken=[node('cluster','循环','cluster'),node('leaf','应用节点','cluster','host')];
 assert.equal(specialistResourcePaths('project',[resource],broken).get('host'),'应用节点');
 assert.equal(specialistTaskRows({...source,workers:[{...worker('foreign'),task:{...worker('foreign').task,projectId:'foreign'}}]}).length,0);
});

test('invalid or future timestamps never claim a fresh update',()=>{
 const now=Date.parse(at);
 assert.equal(specialistTaskTime(undefined,now),'—');assert.equal(specialistTaskTime('bad',now),'—');assert.equal(specialistTaskTime(at,now),'刚刚');
 assert.equal(specialistTaskTime(at,now+120_000),'2 分钟前');assert.notEqual(specialistTaskTime('2027-01-01T01:00:00Z',now),'刚刚');
});

test('chronological rows retain every exact task without reordering when task state changes',()=>{
 const active=worker('active'),attention=worker('attention','blocked'),completed=worker('completed','completed'),stopped=worker('stopped','cancelled');
 const workers=[completed,attention,stopped,active];
 workers.forEach((worker,index)=>{worker.createdAt=new Date(Date.parse(at)-index*60_000).toISOString();});
 const before=JSON.stringify(workers),rows=specialistTaskRows({...source,workers});
 assert.deepEqual(rows.map(row=>row.worker.id),workers.map(worker=>worker.id));
 assert.equal(new Set(rows.map(row=>row.worker.id)).size,workers.length);assert.equal(JSON.stringify(workers),before);
 const updated=workers.map(worker=>({...worker,task:{...worker.task,state:'completed' as const,acceptanceState:'pass' as const}}));
 assert.deepEqual(specialistTaskRows({...source,workers:updated}).map(row=>row.worker.id),rows.map(row=>row.worker.id));
});

test('explicit read controls follow the exact unread cursor and stay disabled offline',()=>{
 const state={cursor:'00000000000000000002',seenCursor:'00000000000000000001'};
 const render=(seenCursor=state.seenCursor,disabled=false)=>renderToStaticMarkup(createElement(ConversationReadButton,{session:'role-channel',state:{...state,seenCursor},disabled}));
 assert.match(render(),/标记已读/);assert.match(render(undefined,true),/disabled=""/);
 assert.equal(render(state.cursor),'');assert.equal(renderToStaticMarkup(createElement(ConversationReadButton,{session:'other-channel'})),'');
 const html=renderToStaticMarkup(createElement(SpecialistTaskList,{channel:{id:'channel',sessionId:'role-channel',projectId:'project',roleId:'ops',roleName:'服务器专员',revision:1,createdAt:at,messageRead:state},rows:[],onTask(){}}));
 assert.match(html,/标记已读/);assert.match(html,/还没有任务/,'a channel with an earlier reply and no task rows still has an acknowledgement entry');
});

test('a disconnected specialist overview keeps its rows and suspends moving indicators',()=>{
 const rows=specialistTaskRows({...source,workers:[worker('a')]});
 const html=renderToStaticMarkup(createElement(SpecialistTaskList,{channel:{id:'channel',sessionId:'channel',projectId:'project',roleId:'ops',roleName:'服务器专员',revision:1,createdAt:at},rows,onTask:()=>{},connected:false}));
 assert.doesNotMatch(html,/连接已断开|正在重连/);assert.match(html,/data-session-id="session-a"/);assert.doesNotMatch(html,/activity-indicator/);
});
