import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {Message,SessionSnapshot,SuperWorker,SuperWorkspace} from '../../shared/contracts';
import {continuousPilotDispatchRows,pilotDispatchRows,pilotSpecialistBinding,pilotSpecialistReply,type PilotSpecialistRow} from '../src/pilotSpecialistReplies';
import {PilotSpecialistReplyView} from '../src/PilotSpecialistConversation';

const at='2026-11-16T00:00:00Z';
const user:Message={id:'question',sessionId:'pilot',role:'user',text:'检查服务器',createdAt:at};
const worker=(id='host'):SuperWorker=>({id,roleId:`role-${id}`,roleName:'服务器专员',sessionId:`worker-${id}`,assignmentState:'active',
 task:{taskId:`task-${id}`,executionGoalId:`goal-${id}`,sessionId:`worker-${id}`,projectId:'project',title:'读取服务器指标',state:'running',acceptanceState:'not_evaluated',revision:1,originRootTurnId:'task-origin',deadlineAt:at},
 activity:{phase:'thinking',label:'正在分析',updatedAt:at,sourceSessionId:'pilot',sourceMessageId:user.id}});
const workspace=(workers=[worker()]):SuperWorkspace=>({active:true,project:{projectId:'project',routerSessionId:'pilot',version:1},workers});
const advance=(previous:PilotSpecialistRow[],state:SuperWorkspace|null|undefined,messages=[user],roots:ReadonlyMap<string,string>=new Map())=>continuousPilotDispatchRows(previous,state,'pilot',messages,roots);
const report=(row:PilotSpecialistRow,root='sdk-root'):Message=>({id:`report-${root}`,sessionId:'pilot',role:'assistant',text:'正式结果',createdAt:at,author:{...row.author,rootTurnId:root}});
const snapshot=(row:PilotSpecialistRow,root='sdk-root'):SessionSnapshot=>({session:{id:row.worker.sessionId,projectId:row.projectId},superagent:{roleId:row.worker.roleId,task:row.worker.task},cursor:1,
 ai:{session:row.worker.sessionId,status:'running',replyStatus:'running',rootTurnId:root,turnStartedAt:at,cards:[{id:'public',type:'message',status:'running',at,content:'这是真实公开进度。',data:{root_turn_id:root}}],cardsOffset:0,totalCards:1}} as SessionSnapshot);
const html=(row:PilotSpecialistRow,state?:SessionSnapshot)=>renderToStaticMarkup(createElement(PilotSpecialistReplyView,{row,snapshot:state}));

test('an observed dispatch survives an activity gap in its original slot without inventing work',()=>{
 const state=workspace([worker(),worker('database')]),initial=advance([],state);
 state.workers[0]!.activity=undefined;
 const gap=advance(initial,state);
 assert.deepEqual(gap.map(row=>row.worker.id),['host','database']);
 assert.equal(pilotSpecialistBinding(gap[0]!),pilotSpecialistBinding(initial[0]!));
 assert.equal(gap[0]!.activity.phase,'updating');assert.equal(gap[0]!.activity.label,'进度暂未更新');
 assert.equal(gap[0]!.continuity,'updating');
 assert.deepEqual(pilotDispatchRows(state,'pilot',[user]).map(row=>row.worker.id),['database'],'fresh admission still requires actual activity');
 assert.deepEqual(advance([],workspace([{...worker(),activity:undefined}])),[],'an unobserved business task cannot invent a participant');
 state.workers[0]!.activity={...worker().activity!,phase:'tool',label:'正在读取指标'};
 const resumed=advance(gap,state);
 assert.equal(resumed[0]!.activity.phase,'tool');assert.equal(resumed[0]!.continuity,undefined);
 assert.equal(pilotSpecialistBinding(resumed[0]!),pilotSpecialistBinding(initial[0]!));
});

test('task completion before report retains true static status despite a stale running child snapshot',()=>{
 for(const [state,label] of [['completed','执行结束'],['failed','执行失败'],['cancelled','已停止']] as const){
  const item=worker(),initial=advance([],workspace([item])),running=snapshot(initial[0]!);
  item.task={...item.task,state};item.activity=undefined;item.assignmentState='parked';
  const retained=advance(initial,workspace([item]),[user],new Map([[pilotSpecialistBinding(initial[0]!), 'sdk-root']]))[0]!;
  assert.equal(retained.continuity,'terminal');assert.equal(retained.activity.label,label);
  const rendered=html(retained,running),plain=rendered.replace(/<[^>]*>/g,'');
  assert.match(plain,/这是真实公开进度/);assert.ok(plain.includes(label));
  assert.doesNotMatch(rendered,/data-live-(?:motion|glow)="active"|status-text--active|data-motion="working"/);
 }
});

test('a task ending before its first SDK snapshot does not leave an unknown-root terminal duplicate',()=>{
 for(const state of ['completed','failed','cancelled'] as const){
  const item=worker(),initial=advance([],workspace([item]));
  item.task={...item.task,state};item.activity=undefined;item.assignmentState='parked';
  const terminal=advance(initial,workspace([item]));
  assert.deepEqual(terminal,[],'only an observed exact invocation can retain a terminal slot');
  assert.deepEqual(advance(terminal,workspace([item]),[user,report(initial[0]!)]),[],'the arriving report cannot invent a root observation or revive the ended slot');
  assert.deepEqual(advance(initial,workspace([item]),[user,report(initial[0]!)]),[],'a report alone is not proof of the unknown invocation');
 }
 const item=worker(),initial=advance([],workspace([item]));item.assignmentState='stopped';item.activity=undefined;
 assert.deepEqual(advance(initial,workspace([item])),[]);
});

test('gap labels preserve current approval and error feedback while remaining still',()=>{
 const item=worker(),initial=advance([],workspace([item]));item.activity=undefined;
 const row=advance(initial,workspace([item]),[user],new Map([[pilotSpecialistBinding(initial[0]!), 'sdk-root']]))[0]!,state=snapshot(row);
 for(const status of ['waiting_approval','failed'] as const){
  const rendered=html(row,{...state,ai:{...state.ai!,status,replyStatus:status,cards:[]}});
  assert.doesNotMatch(rendered,/data-live-(?:motion|glow)="active"/);
  assert.doesNotMatch(rendered,/进度暂未更新/,'an explicit current child status is more useful than an unknown refresh gap');
 }
});

test('only the exact observed SDK root hands the slot to its formal report, without stale-row flashback',()=>{
 const item=worker(),initial=advance([],workspace([item])),key=pilotSpecialistBinding(initial[0]!);
 const roots=new Map([[key,'sdk-root']]);item.activity=undefined;item.task={...item.task,state:'completed'};
 const pending=advance(initial,workspace([item]),[user,report(initial[0]!,'task-origin')],roots)[0]!;
 assert.equal(pending.observedRootTurnId,'sdk-root');assert.match(html(pending),/执行结束/,'the task origin is not the observed SDK root');
 const delivered=advance([pending],workspace([item]),[user,report(initial[0]!)],roots)[0]!;
 assert.equal(html(delivered),'','keep the subscription slot without a visible duplicate');
 item.task={...item.task,state:'running'};item.activity=worker().activity;
 const stale=advance([delivered],workspace([item]),[user,report(initial[0]!)],roots)[0]!;
 assert.equal(html(stale),'','a stale workspace thinking activity cannot flash a new empty reply');
 assert.equal(html(stale,snapshot(stale)),'','the old SDK snapshot remains delivered');
 assert.match(html(stale,snapshot(stale,'sdk-root-next')).replace(/<[^>]*>/g,''),/这是真实公开进度/,'a different exact SDK invocation supersedes the observed root');
 const next=advance([stale],workspace([item]),[user,report(initial[0]!)],new Map([[key,'sdk-root-next']]))[0]!;
 assert.match(html(next),/pilot-specialist-reply/,'the preceding report does not retire the new root');
});

test('reports for another owner or router cannot retire the retained reply',()=>{
 const item=worker(),initial=advance([],workspace([item])),row=initial[0]!,exact=report(row);
 const roots=new Map([[pilotSpecialistBinding(row),'sdk-root']]);item.activity=undefined;
 const mismatches:Message[]=[{...exact,sessionId:'other-router'},...(['workerId','sessionId','taskId','roleId'] as const).map(field=>({...exact,author:{...exact.author!,[field]:'other'}}))];
 for(const wrong of mismatches){
  const retained=advance(initial,workspace([item]),[user,wrong],roots)[0]!;
  assert.deepEqual(retained.reportedTurns,[]);assert.match(html(retained),/进度暂未更新/);
 }
});

test('an activity gap cannot expose a new SDK invocation until its Pilot source is proven again',()=>{
 const item=worker(),initial=advance([],workspace([item])),roots=new Map([[pilotSpecialistBinding(initial[0]!), 'sdk-root']]);
 item.activity=undefined;
 const retained=advance(initial,workspace([item]),[user],roots)[0]!;
 const direct=snapshot(retained,'direct-channel-root');
 assert.equal(pilotSpecialistReply(retained,direct),undefined);
 assert.doesNotMatch(html(retained,direct),/这是真实公开进度/,'same task and worker are insufficient to infer a new source');
 assert.equal(pilotSpecialistReply({...retained,observedRootTurnId:undefined},snapshot(retained)),undefined,'a previously unobserved gap cannot borrow any snapshot root');
 const prior=snapshot(retained);
 assert.equal(pilotSpecialistReply(retained,prior)?.reply?.turnId,'sdk-root');
 item.activity=worker().activity;
 const resumed=advance([retained],workspace([item]),[user],roots)[0]!;
 assert.equal(resumed.continuity,undefined);
 assert.equal(pilotSpecialistReply(resumed,direct)?.reply?.turnId,'direct-channel-root','fresh Pilot activity reestablishes the source before admitting a new root');
});

test('retention cannot cross worker, role, session, task, execution, project or source ownership',()=>{
 const initial=advance([],workspace());
 const changes:((state:SuperWorkspace)=>void)[]=[
  state=>{state.workers=[]},state=>{state.active=false},state=>{state.project.projectId='other'},state=>{state.project.routerSessionId='other'},
  state=>{state.workers[0]!.id='other'},state=>{state.workers[0]!.roleId='other'},state=>{state.workers[0]!.sessionId='other'},
  state=>{state.workers[0]!.task.taskId='other'},state=>{state.workers[0]!.task.sessionId='other'},state=>{state.workers[0]!.task.projectId='other'},
  state=>{state.workers[0]!.task.executionGoalId='other'},state=>{state.workers[0]!.task.executionGoalId=undefined},
  state=>{state.workers[0]!.parentWorkerId='parent'},state=>{state.workers[0]!.assignmentState='archived'},
  state=>{state.workers[0]!.execution={backend:{kind:'acp',agent:'codex'},source:'task_assignment',assignedAt:at,runs:[],totalRuns:0}},
 ];
 for(const change of changes){const state=workspace([{...worker(),activity:undefined}]);change(state);assert.deepEqual(advance(initial,state),[]);}
 for(const state of [null,undefined])assert.deepEqual(advance(initial,state),[]);
 assert.deepEqual(advance(initial,workspace([{...worker(),activity:undefined}]),[]),[],'a clipped or deleted source is not moved to a newer turn');
 const direct=worker();direct.activity!.sourceSessionId='specialist-channel';
 assert.deepEqual(advance(initial,workspace([direct])),[]);
 const cleared=advance(initial,null);
 assert.deepEqual(advance(cleared,workspace([{...worker(),activity:undefined}])),[],'returning after a clear cannot resurrect a slot');
});

test('a followup replaces the source binding and never borrows the preceding observed root',()=>{
 const item=worker(),initial=advance([],workspace([item])),roots=new Map([[pilotSpecialistBinding(initial[0]!), 'old-sdk-root']]);
 const followup:Message={...user,id:'followup',createdAt:'2026-11-16T00:00:01Z'};
 item.activity!.sourceMessageId=followup.id;
 const rows=advance(initial,workspace([item]),[user,followup],roots);
 assert.equal(rows.length,1);assert.equal(rows[0]!.sourceMessageId,followup.id);assert.equal(rows[0]!.observedRootTurnId,undefined);
 item.activity=undefined;
 const dispatch:Message={id:'dispatch',sessionId:'pilot',role:'assistant',text:'',createdAt:followup.createdAt,dispatch:{id:'decision',workerId:item.id,sessionId:item.sessionId,roleId:item.roleId,roleName:item.roleName,taskId:item.task.taskId,sourceMessageId:followup.id,instruction:'继续检查',action:'followup'}};
 assert.deepEqual(advance(initial,workspace([item]),[user,followup,dispatch],roots),[],'a committed different source invalidates the previous slot during a startup gap');
});

test('current identity metadata updates during a retained slot without preserving old role names',()=>{
 const item=worker(),initial=advance([],workspace([item]));item.activity=undefined;item.roleName='新的专员名字';
 const state=workspace([item]);state.channels=[{id:'channel',roleId:item.roleId,roleName:item.roleName,sessionId:'current-channel',projectId:'project',revision:2,createdAt:at}];
 const retained=advance(initial,state)[0]!;
 assert.equal(retained.author.name,item.roleName);assert.equal(retained.worker,item);
 assert.equal(retained.author.channelSessionId,'current-channel');
 for(const [state,label] of [['waiting_user','等待你补充信息'],['waiting_external','等待外部结果'],['paused','已暂停']] as const){
  item.task={...item.task,state};assert.equal(advance(initial,workspace([item]))[0]!.activity.label,label);
 }
});
