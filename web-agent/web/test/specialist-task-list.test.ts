import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {SessionSnapshot,SpecialistChannelEntry,SuperWorker,Resource,ResourceTreeNode} from '../../shared/contracts';
import {filterSpecialistTasks,specialistResourcePaths,specialistTaskRows,specialistTaskTime} from '../src/specialistTaskListModel';
import {SpecialistTaskList} from '../src/SpecialistTaskList';
import {ConversationReadButton} from '../src/ConversationReadMarker';

const at='2026-11-11T01:00:00Z';
const worker=(id:string,state:SuperWorker['task']['state']='running'):SuperWorker=>({id,sessionId:`session-${id}`,roleId:'ops',roleName:'服务器专员',createdAt:at,assignmentState:state==='running'?'active':'parked',task:{taskId:`task-${id}`,sessionId:`session-${id}`,projectId:'project',title:'同名检查任务',state,acceptanceState:state==='completed'?'pass':'not_evaluated',revision:1,originRootTurnId:'root',deadlineAt:'',updatedAt:at,resources:[{runtime:'ssh',assetRef:'host'}]},execution:{backend:{kind:'acp',agent:'codex',revision:2},assignedAt:at,source:'task_assignment',runs:[],totalRuns:0}});
const resource={id:'host',projectId:'project',name:'应用节点',kind:'ssh',status:'available',description:'private-description',ssh:{host:'private-host',username:'private-user',credentialRef:'private-ref'}} as Resource;
const node=(id:string,name:string,parentId:string|null=null,resourceId:string|null=null):ResourceTreeNode=>({id,name,parentId,resourceId,projectId:'project',kind:resourceId?'resource':'folder',position:0});
const tree=[node('root','演示环境'),node('cluster','业务集群','root'),node('leaf','应用节点','cluster','host')];
const source={projectId:'project',resources:[resource],resourceTree:tree};

test('task rows retain exact identities, Lake role avatars and frozen executor bindings',()=>{
 const a=worker('a'),b=worker('b','completed');b.execution=undefined;
 const before=JSON.stringify([a,b]);
 const rows=specialistTaskRows({...source,workers:[a,b]});
 assert.equal(rows.length,2);assert.equal(rows[0].worker.sessionId,'session-a');assert.equal(rows[1].worker.sessionId,'session-b');
 assert.equal(rows[0].agent,'Codex');assert.equal(rows[1].agent,'Lake Worker');assert.equal(rows[1].state.label,'已验收');
 assert.equal(rows[0].progress,undefined,'missing progress cannot become an invented percentage');
 assert.deepEqual(rows[0].paths,['演示环境 / 业务集群 / 应用节点']);
 const html=renderToStaticMarkup(createElement(SpecialistTaskList,{channel:{id:'channel',sessionId:'channel',projectId:'project',roleId:'ops',roleName:'服务器专员',revision:1,createdAt:at},rows,selectedSessionId:'session-b',onTask:()=>{}}));
 assert.match(html,/aria-label="专员任务列表"/);assert.match(html,/aria-current="true"/);assert.match(html,/data-task-id="task-a"/);assert.match(html,/data-task-id="task-b"/);
 assert.match(html,/openai.svg/);assert.match(html,/super-role-avatar/);assert.match(html,/未报告/);assert.doesNotMatch(html,/private-host|private-user|private-ref|private-description/);
 assert.equal(JSON.stringify([a,b]),before);
});

test('attention and execution reflect the actual task instead of an external answer or sibling question',()=>{
 const done=worker('done','completed');done.task.acceptanceState='insufficient';
 const stopped=worker('stopped','cancelled'),waiting=worker('waiting','running'),active=worker('active');waiting.activity={phase:'waiting_approval',label:'等待确认',updatedAt:at};
 active.execution!.runs=[{id:'answered',agent:'codex',scope:'worker',state:'completed',dispatchPhase:'answered',createdAt:at,updatedAt:at,usage:null,summary:'外部自报完成'}];
 const rows=specialistTaskRows({...source,workers:[done,stopped,waiting,active]});
 const byId=(id:string)=>rows.find(row=>row.worker.id===id)!;
 assert.equal(byId('done').filter,'attention');assert.equal(byId('done').state.label,'待验收');
 assert.equal(byId('waiting').state.label,'待确认');assert.equal(byId('waiting').moving,false);assert.equal(byId('active').moving,true);assert.equal(byId('active').filter,'active');
 assert.equal(byId('stopped').state.label,'已停止');assert.equal(byId('stopped').moving,false);
 assert.deepEqual(filterSpecialistTasks(rows,'attention','').map(row=>row.worker.id).sort(),['done','waiting']);
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
 assert.equal(filterSpecialistTasks(rows,'all','业务集群').length,1);assert.equal(filterSpecialistTasks(rows,'active','ＣＯＤＥＸ').length,1);
 assert.equal(filterSpecialistTasks(rows,'all','演示环境/业务集群').length,1);
 assert.equal(filterSpecialistTasks(rows,'all','other-project').length,0);assert.equal(filterSpecialistTasks(rows,'completed','业务集群').length,0);
 const broken=[node('cluster','循环','cluster'),node('leaf','应用节点','cluster','host')];
 assert.equal(specialistResourcePaths('project',[resource],broken).get('host'),'应用节点');
 assert.equal(specialistTaskRows({...source,workers:[{...worker('foreign'),task:{...worker('foreign').task,projectId:'foreign'}}]}).length,0);
});

test('invalid or future timestamps never claim a fresh update',()=>{
 const now=Date.parse(at);
 assert.equal(specialistTaskTime(undefined,now),'—');assert.equal(specialistTaskTime('bad',now),'—');assert.equal(specialistTaskTime(at,now),'刚刚');
 assert.equal(specialistTaskTime(at,now+120_000),'2 分钟前');assert.notEqual(specialistTaskTime('2027-01-01T01:00:00Z',now),'刚刚');
});

test('explicit read controls follow the exact unread cursor and stay disabled offline',()=>{
 const state={cursor:'00000000000000000002',seenCursor:'00000000000000000001'};
 const render=(seenCursor=state.seenCursor,disabled=false)=>renderToStaticMarkup(createElement(ConversationReadButton,{session:'role-channel',state:{...state,seenCursor},disabled}));
 assert.match(render(),/标记已读/);assert.match(render(undefined,true),/disabled=""/);
 assert.equal(render(state.cursor),'');assert.equal(renderToStaticMarkup(createElement(ConversationReadButton,{session:'other-channel'})),'');
 const html=renderToStaticMarkup(createElement(SpecialistTaskList,{channel:{id:'channel',sessionId:'role-channel',projectId:'project',roleId:'ops',roleName:'服务器专员',revision:1,createdAt:at,messageRead:state},rows:[],onTask(){}}));
 assert.match(html,/标记已读/);assert.match(html,/还没有任务/,'a channel with an earlier reply and no task rows still has an acknowledgement entry');
});

test('a disconnected task page keeps its rows while disabling new dispatch and moving indicators',()=>{
 const rows=specialistTaskRows({...source,workers:[worker('a')]});
 const html=renderToStaticMarkup(createElement(SpecialistTaskList,{channel:{id:'channel',sessionId:'channel',projectId:'project',roleId:'ops',roleName:'服务器专员',revision:1,createdAt:at},rows,onTask:()=>{},onNewTask:()=>{},connected:false}));
 assert.match(html,/正在重连/);assert.match(html,/specialist-new-task" disabled=""/);assert.match(html,/data-session-id="session-a"/);assert.doesNotMatch(html,/activity-indicator/);
});
