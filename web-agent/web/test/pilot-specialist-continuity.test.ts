import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {Message,SessionSnapshot,SuperWorker,SuperWorkspace} from '../../shared/contracts';
import {awaitingPilotReport,continuousPilotDispatchRows,pilotDispatchRows,pilotSpecialistBinding,pilotSpecialistPresentation,pilotSpecialistReply,type PilotSpecialistRow} from '../src/pilotSpecialistReplies';
import {PilotSpecialistReplyView} from '../src/PilotSpecialistConversation';
import {SpecialistLiveReply} from '../src/SpecialistChannel';
import {redundantJointReports} from '../src/pilotReportGroups';

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

test('both specialist surfaces keep one animal on the latest Codex prose through a tool call',()=>{
 const row=advance([],workspace())[0]!,state=snapshot(row),turnId=state.ai!.rootTurnId;
 state.ai!.cards.push({id:'run',type:'operation',at,status:'running',data:{
  source:'external_agent',external_agent:'codex',external_run_id:'run',taskId:row.worker.task.executionGoalId,root_turn_id:turnId,
  codex_activity:[{kind:'text',id:'a',text:'第一阶段'},{kind:'text',id:'b',text:'接着核对记录'},
   {kind:'command',id:'c',text:'date',status:'running',at}]}});
 for(const connected of [true,false]){
  const pilot=renderToStaticMarkup(createElement(PilotSpecialistReplyView,{row,snapshot:state,available:connected}));
  const channel=renderToStaticMarkup(createElement(SpecialistLiveReply,{worker:row.worker,snapshot:state,turnId,connected}));
  for(const html of [pilot,channel]){
   assert.doesNotMatch(html,/>date<\/code>/);
   assert.match(html,/aria-expanded="false"/);
   assert.ok(html.includes(connected?'正在运行 1 条命令':'待确认 · 运行 1 条命令'));
   assert.equal((html.match(/class="specialist-reply-cursor"/g)??[]).length,connected?1:0);
   if(connected)assert.match(html,/class="specialist-reply-cursor-tail">录<span/);
  }
 }
});

test('an Antigravity turn with only saved tool events renders the process before public prose',()=>{
 const row=advance([],workspace())[0]!,state=snapshot(row),turnId=state.ai!.rootTurnId;
 state.ai!.cards=[{id:'run',type:'operation',at,status:'running',data:{
  source:'external_agent',external_agent:'antigravity',external_run_id:'run',taskId:row.worker.task.executionGoalId,root_turn_id:turnId,
  external_events:[
   {kind:'tool',callId:'one',title:'检查资源',status:'pending',at},
   {kind:'tool_update',callId:'one',status:'completed',at},
   {kind:'tool',callId:'two',title:'核对记录',status:'in_progress',at},
  ],
 }}];
 assert.match(html(row,state),/已调用 1 个工具，正在调用 1 个工具/);
 assert.doesNotMatch(html(row,state),/工具调用 ·|>检查资源<|>核对记录</);
 const foreign={...state,ai:{...state.ai!,rootTurnId:'other-root'}};
 assert.doesNotMatch(html(row,foreign),/已调用 1 个工具|正在调用 1 个工具/);
});

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

test('successful completion before a report keeps prose without an extra ending notice; failures and stops remain visible',()=>{
 for(const [state,label] of [['completed','执行结束'],['failed','执行失败'],['cancelled','已停止']] as const){
  const item=worker(),initial=advance([],workspace([item])),running=snapshot(initial[0]!);
  item.task={...item.task,state};item.activity=undefined;item.assignmentState='parked';
  const retained=advance(initial,workspace([item]),[user],new Map([[pilotSpecialistBinding(initial[0]!), 'sdk-root']]))[0]!;
  assert.equal(retained.continuity,'terminal');assert.equal(retained.activity.label,label);
  const rendered=html(retained,running),plain=rendered.replace(/<[^>]*>/g,'');
  assert.match(plain,/这是真实公开进度/);
  if(state==='completed')assert.doesNotMatch(plain,/执行结束|回复结束|接收结果/);
  else assert.ok(plain.includes(label));
  assert.doesNotMatch(rendered,/data-live-(?:motion|glow)="active"|status-text--active|data-motion="working"/);
 }
});

test('the completed-task report gap freezes the last committed public segment through late prose and missing SDK snapshots',()=>{
 const item=worker(),initial=advance([],workspace([item]))[0]!,live=snapshot(initial);
 const entry=pilotSpecialistPresentation(initial,live)!,binding=pilotSpecialistBinding(initial),previous={binding,entry};
 item.task={...item.task,state:'completed'};item.activity=undefined;item.assignmentState='parked';
 const row=advance([initial],workspace([item]),[user],new Map([[binding,'sdk-root']]))[0]!;
 assert.equal(awaitingPilotReport(row),true);
 const late=snapshot(row);late.ai!.cards[0]!.content='执行已经结束，正在整理结论。';
 const missing={...late,ai:{...late.ai!,cards:[],rootTurnId:undefined}};
 for(const current of [late,missing,undefined]){
  assert.equal(pilotSpecialistPresentation(row,current,previous),entry,'the exact retained paragraph survives each terminal transport update');
  assert.equal(entry.card?.content,'这是真实公开进度。');
 }
 const final=report(initial),delivered=advance([row],workspace([item]),[user,final],new Map([[binding,'sdk-root']]))[0]!;
 assert.equal(delivered.finalReport,final,'only the exact host report replaces the retained content');
});

test('a retained public segment cannot cross its binding, SDK root, resumed work or actual failure',()=>{
 const item=worker(),initial=advance([],workspace([item]))[0]!,live=snapshot(initial);
 const previous={binding:pilotSpecialistBinding(initial),entry:pilotSpecialistPresentation(initial,live)};
 const row:PilotSpecialistRow={...initial,worker:{...item,task:{...item.task,state:'completed'}},continuity:'terminal',observedRootTurnId:'sdk-root'};
 for(const changed of [
  {...row,projectId:'other'}, {...row,sourceMessageId:'other'}, {...row,sourceCreatedAt:'later'},
  {...row,worker:{...row.worker,id:'other'}}, {...row,worker:{...row.worker,roleId:'other'}},
  {...row,worker:{...row.worker,sessionId:'other'}}, {...row,worker:{...row.worker,task:{...row.worker.task,taskId:'other'}}},
  {...row,observedRootTurnId:'new-root'},
 ])assert.equal(pilotSpecialistPresentation(changed,undefined,previous),undefined);
 const resumed={...initial,observedRootTurnId:'sdk-root'},next=snapshot(resumed,'new-root');
 next.ai!.cards[0]!.content='下一次执行的真实进度。';
 assert.equal(pilotSpecialistPresentation(resumed,next,previous)?.card?.content,'下一次执行的真实进度。');
 for(const state of ['failed','cancelled'] as const){
  const failed={...row,worker:{...row.worker,task:{...row.worker.task,state}}};
  assert.equal(awaitingPilotReport(failed),false);
  assert.equal(pilotSpecialistPresentation(failed,undefined,previous),undefined,'failure presentation is never replaced by a retained running paragraph');
 }
});

test('a matching worker completion snapshot can freeze prose before the workspace learns that execution ended',()=>{
 const item=worker(),initial=advance([],workspace([item]))[0]!,row={...initial,observedRootTurnId:'sdk-root'},live=snapshot(row);
 const previous={binding:pilotSpecialistBinding(row),entry:pilotSpecialistPresentation(row,live)};
 const done=snapshot(row);done.superagent!.task={...done.superagent!.task,state:'completed'};done.ai!.cards[0]!.content='收尾播报';
 assert.equal(awaitingPilotReport(row,done),true);
 assert.equal(pilotSpecialistPresentation(row,done,previous),previous.entry);
 const next=snapshot(row,'new-root');next.superagent!.task={...next.superagent!.task,state:'completed'};
 assert.equal(awaitingPilotReport(row,next),false,'a different SDK invocation is not a completion signal for the old one');
 const other={...done,session:{...done.session,id:'other-session'}};
 assert.equal(awaitingPilotReport(row,other),false);
 assert.equal(pilotSpecialistPresentation(row,other,previous),undefined);
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
 assert.equal(pending.observedRootTurnId,'sdk-root');assert.equal(pending.finalReport,undefined);
 assert.doesNotMatch(html(pending),/正式结果|执行结束/,'an unproven report cannot invent a public completion sentence');
 const final=report(initial[0]!);
 const delivered=advance([pending],workspace([item]),[user,final],roots)[0]!;
 assert.equal(delivered.finalReport,final,'the actual frozen report belongs to the original slot');
 const rendered=html(delivered);
 assert.match(rendered.replace(/<[^>]*>/g,''),/正式结果/);assert.doesNotMatch(rendered,/data-live-(?:motion|glow)="active"|status-text--active|data-motion="working"/);
 item.task={...item.task,state:'running'};item.activity=worker().activity;
 const stale=advance([delivered],workspace([item]),[user,final],roots)[0]!;
 assert.equal(stale.finalReport,final);assert.match(html(stale).replace(/<[^>]*>/g,''),/正式结果/,'a stale workspace thinking activity cannot flash a new empty reply');
 assert.match(html(stale,snapshot(stale)).replace(/<[^>]*>/g,''),/正式结果/,'the old SDK snapshot remains delivered');
 assert.doesNotMatch(html(stale,snapshot(stale)),/这是真实公开进度|data-live-(?:motion|glow)="active"/);
 assert.match(html(stale,snapshot(stale,'sdk-root-next')).replace(/<[^>]*>/g,''),/这是真实公开进度/,'a different exact SDK invocation supersedes the observed root');
 const next=advance([stale],workspace([item]),[user,report(initial[0]!)],new Map([[key,'sdk-root-next']]))[0]!;
 assert.equal(next.finalReport,undefined,'a new root cannot inherit the preceding final report');
 assert.match(html(next),/pilot-specialist-reply/,'the preceding report does not retire the new root');
});

test('reports for another owner or router cannot retire the retained reply',()=>{
 const item=worker(),initial=advance([],workspace([item])),row=initial[0]!,exact=report(row);
 const roots=new Map([[pilotSpecialistBinding(row),'sdk-root']]);item.activity=undefined;
 const mismatches:Message[]=[{...exact,sessionId:'other-router'},...(['workerId','sessionId','taskId','roleId'] as const).map(field=>({...exact,author:{...exact.author!,[field]:'other'}}))];
 for(const wrong of mismatches){
  const retained=advance(initial,workspace([item]),[user,wrong],roots)[0]!;
  assert.deepEqual(retained.reportedTurns,[]);assert.equal(retained.finalReport,undefined);assert.match(html(retained),/进度暂未更新/);
 }
});

test('a host-confirmed report replaces the same task slot across SDK invocations',()=>{
 const item=worker(),initial=advance([],workspace([item])),row=initial[0]!;
 const roots=new Map([[pilotSpecialistBinding(row),'sdk-root']]);
 const result={...report(row,'finish-root'),replyToMessageId:user.id,text:'正式结论。'};
 const beforeWorkspace=advance(initial,workspace([item]),[user,result],roots)[0]!;
 assert.equal(beforeWorkspace.finalReport,result,'the report stream can lead the workspace stream');
 const rendered=html(beforeWorkspace,snapshot(row));
 assert.match(rendered.replace(/<[^>]*>/g,''),/正式结论。/);
 assert.doesNotMatch(rendered,/class="specialist-reply-cursor"/);
 item.activity=undefined;item.assignmentState='parked';item.task={...item.task,state:'completed'};
 item.pilotReport={messageId:result.id,executionSettled:true};
 assert.equal(advance(initial,workspace([item]),[user,result])[0]!.finalReport,result);
 const wrongSource={...result,replyToMessageId:'another-question'};
 assert.equal(advance(initial,workspace([item]),[user,wrongSource],roots)[0]!.finalReport,undefined);
});

test('the live specialist process is hidden as the formal report first arrives',()=>{
 const row=advance([],workspace())[0]!;
 const final:Message={...report(row),author:{...row.author,rootTurnId:'sdk-root',durationMs:135000},codexActivity:[
  {kind:'text',id:'step',text:'正在核对记录。'},
  {kind:'integration',id:'call',text:'查询记录',status:'completed',at},
 ]};
 const delivered={...row,finalReport:final};
 const render=(arriveReport:boolean)=>renderToStaticMarkup(createElement(PilotSpecialistReplyView,{
  row:delivered,arriveReport,onInspectSpecialist(){},
 }));
 for(const arrives of [true,false]){
  const html=render(arrives);
  assert.match(html,/正式结果[\s\S]*aria-label="查看服务器专员的执行过程"[^>]*aria-expanded="false"[\s\S]*2 分钟 15 秒[\s\S]*aria-hidden="true" inert="" hidden=""[\s\S]*正在核对记录。/);
  assert.doesNotMatch(html,/data-placement="side"/);
 }
});

test('published stage prose keeps working motion and trims only its terminal full stop',()=>{
 const item=worker(),row=advance([],workspace([item]))[0]!;
 const live=snapshot(row),ai=live.ai!;
 const rendered=html(row,{...live,ai:{...ai,status:'completed',replyStatus:'completed',
  cards:ai.cards.map(card=>({...card,status:'completed',content:'先核对版本 1.4。正在查看样例记录。'}))}});
 assert.match(rendered,/data-motion="working"/);
 assert.match(rendered.replace(/<[^>]*>/g,''),/先核对版本 1\.4。正在查看样例记录(?!。)/);
 assert.match(rendered,/class="specialist-reply-cursor-tail">录<span class="specialist-reply-cursor" data-cursor-avatar="[a-z-]+" aria-hidden="true"/);

 const paused=renderToStaticMarkup(createElement(PilotSpecialistReplyView,{row,snapshot:live,available:false}));
 assert.doesNotMatch(paused,/class="specialist-reply-cursor"/);
});

test('Pilot uses the speaking specialist’s avatar for the cursor and removes it on delivery',()=>{
 for(const [avatar,feature] of [['rabbit','ear'],['kingfisher','plume'],['owl','eyes'],['beaver','artwork']] as const){
  const initial=advance([],workspace())[0]!;
  const row={...initial,author:{...initial.author,avatarId:avatar}};
  const live=snapshot(row);
  const rendered=html(row,live);
  assert.match(rendered,new RegExp(`class="super-role-avatar" data-role="${avatar}"`));
  assert.match(rendered,new RegExp(`class="specialist-reply-cursor" data-cursor-avatar="${avatar}" aria-hidden="true"`));
  assert.match(rendered,new RegExp(`class="specialist-cursor-${feature}"`));
  if(avatar==='beaver')assert.match(rendered,/class="specialist-cursor-artwork" data-family="otter" data-part="tail"/);
  const delivered=html({...row,finalReport:{...report(row),text:'核对已完成。'}},live);
  assert.doesNotMatch(delivered,/class="specialist-reply-cursor"/);
  assert.match(delivered,/核对已完成。/);
 }
});

test('hide a repeated joint receipt only when all copied originals are in the same user turn',()=>{
 const [a,b]=advance([],workspace([worker(),worker('db')]));
 const first={...report(a!),id:'first',replyToMessageId:user.id,text:'检查 A 完成。'};
 const second={...report(b!),id:'second',replyToMessageId:user.id,text:'检查 B 完成。',author:{...b!.author,taskId:a!.worker.task.taskId}};
 const aggregate:Message={id:'aggregate',sessionId:user.sessionId,role:'assistant',createdAt:at,
  jointReport:{taskId:a!.worker.task.taskId,reportId:'aggregate-id'},text:'「核对」的 2 位专员均已提交报告。\n\n专员甲：检查 A 完成。\n\n专员乙：检查 B 完成。'};
 assert.deepEqual([...redundantJointReports([first,second,aggregate])],['aggregate']);
 assert.equal(redundantJointReports([first,aggregate]).size,0);
 assert.equal(redundantJointReports([first,{...second,replyToMessageId:'another'},aggregate]).size,0);
 assert.equal(redundantJointReports([first,second,{...aggregate,text:'这是 Pilot 独立写的结论。'}]).size,0);
});

test('final report projection requires an observed root and a formal specialist message without guessing from text',()=>{
 const item=worker(),initial=advance([],workspace([item])),row=initial[0]!,exact=report(row),roots=new Map([[pilotSpecialistBinding(row),'sdk-root']]);
 assert.equal(advance(initial,workspace([item]),[user,exact])[0]!.finalReport,undefined,'a matching report cannot invent observation');
 const wrongReports:Message[]=[report(row,'other-root'),{...exact,role:'system'},{...exact,author:undefined},
  {...exact,author:{...exact.author!,rootTurnId:undefined}},{...exact,author:{...exact.author!,taskId:undefined}},
  {...exact,author:{...exact.author!,roleId:undefined}}];
 for(const wrong of wrongReports)assert.equal(advance(initial,workspace([item]),[user,wrong],roots)[0]!.finalReport,undefined);
 const delivered=advance(initial,workspace([item]),[user,exact],roots)[0]!;
 assert.equal(delivered.finalReport,exact);assert.deepEqual(delivered.reportedTurns,['sdk-root']);
 assert.equal(advance([delivered],workspace([item]),[user],roots)[0]!.finalReport,undefined,'removed reports are not restored from cached rows');
});

test('a final report arriving after another user message stays in its original source slot',()=>{
 const item=worker(),initial=advance([],workspace([item])),row=initial[0]!,roots=new Map([[pilotSpecialistBinding(row),'sdk-root']]);
 const later:Message={...user,id:'later-question',text:'另一个问题',createdAt:'2026-11-16T00:00:02Z'};
 const final={...report(row),createdAt:'2026-11-16T00:00:03Z'};
 item.activity=undefined;item.task={...item.task,state:'completed'};
 const delivered=advance(initial,workspace([item]),[user,later,final],roots)[0]!;
 assert.equal(delivered.sourceMessageId,user.id);assert.equal(delivered.sourceCreatedAt,user.createdAt);
 assert.equal(pilotSpecialistBinding(delivered),pilotSpecialistBinding(row));assert.equal(delivered.finalReport,final);
 assert.equal(advance([delivered],workspace([item]),[later,final],roots).length,0,'a missing original source cannot move its report into the later user turn');
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
 const rows=advance(initial,workspace([item]),[user,followup,report(initial[0]!,'old-sdk-root')],roots);
 assert.equal(rows.length,1);assert.equal(rows[0]!.sourceMessageId,followup.id);assert.equal(rows[0]!.observedRootTurnId,undefined);assert.equal(rows[0]!.finalReport,undefined);
 item.activity=undefined;
 const dispatch:Message={id:'dispatch',sessionId:'pilot',role:'assistant',text:'',createdAt:followup.createdAt,dispatch:{id:'decision',workerId:item.id,sessionId:item.sessionId,roleId:item.roleId,roleName:item.roleName,taskId:item.task.taskId,sourceMessageId:followup.id,instruction:'继续检查',action:'followup'}};
 assert.deepEqual(advance(initial,workspace([item]),[user,followup,dispatch],roots),[],'a committed different source invalidates the previous slot during a startup gap');
});

test('an observed root cannot claim a report explicitly bound to another human input',()=>{
 const state=workspace(), initial=advance([],state), row=initial[0]!;
 const roots=new Map([[pilotSpecialistBinding(row),'sdk-root']]);
 const other={...user,id:'other-user'};
 const message={...report(row),replyToMessageId:other.id};
 assert.equal(advance(initial,state,[user,other,message],roots)[0]!.finalReport,undefined);
 assert.equal(advance(initial,state,[user,other,{...message,replyToMessageId:user.id}],roots)[0]!.finalReport?.id,message.id);
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
