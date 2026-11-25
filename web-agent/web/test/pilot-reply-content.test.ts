import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {SessionSnapshot} from '../../shared/contracts';
import type {PilotSpecialistRow} from '../src/pilotSpecialistReplies';
import {PilotSpecialistReplyView,shouldSubscribePilotReply} from '../src/PilotSpecialistConversation';
import {TextReveal,TEXT_REVEAL_MAX_LAG_MS} from '../src/textReveal';
import {changesPilotReplyContent,PILOT_REPLY_EXIT_MS,PILOT_REPLY_TRANSITION_MS,PilotReplyContent,PilotReplyContentTransition,type PilotReplyContentState} from '../src/PilotReplyContent';

const content=(text:string,extra:Partial<PilotReplyContentState>={}):PilotReplyContentState=>({binding:'project/role/worker/task/source',kind:'prose',id:'first-card',text,...extra});
const thinking=content('正在抱石琢磨中',{kind:'status',id:''});

function transitionHarness(){
 const calls:{frames:Keyframe[];options:KeyframeAnimationOptions;animation:Animation&{cancelled:number}}[]=[];
 const committed:PilotReplyContentState[]=[];
 const presented:PilotReplyContentState[]=[];
 const visual:{clipPath:string;height?:string}={clipPath:'inset(0% 38% 0% 0%)'};
 const surface={animate(frames:Keyframe[],options:KeyframeAnimationOptions){
  const animation={onfinish:null,cancelled:0,cancel(){this.cancelled++;}} as unknown as Animation&{cancelled:number};
  calls.push({frames,options,animation});return animation;
 }};
 const transition=new PilotReplyContentTransition(surface as unknown as HTMLElement,()=>({...visual}),next=>committed.push(next),next=>presented.push(next));
 const clips=()=>calls.filter(call=>call.frames[0]?.clipPath!==undefined);
 const finish=(call=clips().at(-1)!)=>call.animation.onfinish!.call(call.animation,{} as AnimationPlaybackEvent);
 return {transition,calls,visual,committed,presented,clips,finish};
}

test('the final report is ready for the island only after its replacement has been revealed',()=>{
 const h=transitionHarness(),progress=content('进度文字'),report=content('正式报告',{id:'report-id'});
 h.transition.update(progress,true);
 h.transition.update(report,true);
 assert.deepEqual(h.presented,[progress]);
 h.finish(); // retiring progress can commit the report but cannot mark it visible yet
 h.transition.update(report,true);
 assert.deepEqual(h.presented,[progress]);
 h.finish();
 assert.deepEqual(h.presented,[progress,report]);
 const reduced=transitionHarness();
 reduced.transition.update(progress,true);
 reduced.transition.update(report,false);
 assert.equal(reduced.presented.at(-1),report);
});

test('new reply identities can transition while edits within a paragraph or status stay in place',()=>{
 const first=content('已经读取主机信息。');
 assert.equal(changesPilotReplyContent(undefined,thinking),false);
 assert.equal(changesPilotReplyContent(thinking,first),true);
 assert.equal(changesPilotReplyContent(first,content(first.text+'接下来检查数据库。')),false);
 assert.equal(changesPilotReplyContent(first,{...first,id:'another-id'}),false);
 assert.equal(changesPilotReplyContent(first,content('新的进度。',{id:'next'})),true);
 assert.equal(changesPilotReplyContent(first,content('同段真实修正。')),false);
 assert.equal(changesPilotReplyContent(thinking,content('正在读取文件',{kind:'status',id:''})),false);
 assert.equal(changesPilotReplyContent(first,content('其他任务',{binding:'other'})),false);
});

test('old text retires right to left before the one body commits and reveals new text left to right',()=>{
 const {transition,committed,clips,finish}=transitionHarness(),next=content('真实公开回复');
 transition.update(thinking,true);transition.update(next,true);
 assert.equal(committed.at(-1),thinking,'the old readable body remains until its exit finishes');
 assert.deepEqual(clips()[0]!.frames,[{clipPath:'inset(0% 0% 0% 0%)'},{clipPath:'inset(0% 100% 0% 0%)'}]);
 assert.equal(clips()[0]!.options.duration,PILOT_REPLY_EXIT_MS);
 finish();assert.equal(committed.at(-1),next);
 transition.update(next,true);
 assert.deepEqual(clips()[1]!.frames,[{clipPath:'inset(0% 100% 0% 0%)'},{clipPath:'inset(0% 0% 0% 0%)'}]);
 assert.equal(clips()[1]!.options.duration,PILOT_REPLY_TRANSITION_MS);
 finish();assert.equal(clips()[1]!.animation.cancelled,1,'the reveal releases all fill after finishing');
 assert.equal(clips()[1]!.animation.onfinish,null);
});

test('the first live prose replaces a retiring status immediately',()=>{
 const h=transitionHarness(),first=content('真实首字',{live:true});
 h.transition.update(thinking,true);
 h.transition.update(content('正在处理',{kind:'status',id:'another-status'}),true);
 assert.equal(h.clips().length,1);
 assert.equal(changesPilotReplyContent(thinking,first),false);
 h.transition.update(first,true);
 assert.equal(h.committed.at(-1),first);
 assert.equal(h.clips().length,1);
 assert.equal(h.clips()[0]!.animation.cancelled,1);
});

test('new live prose opens vertically without delaying the first commit or restarting on a prefix',()=>{
 const h=transitionHarness(),first=content('首段公开回复',{live:true,arrive:true});
 h.transition.update(thinking,true,22);
 h.transition.update(first,true,28);
 assert.equal(h.committed.at(-1),first);
 assert.equal(h.presented.at(-1),thinking);
 assert.deepEqual(h.clips()[0]!.frames,[
  {clipPath:'inset(0% -4px 100% -4px)'},
  {clipPath:'inset(0% -4px -4px -4px)'},
 ]);
 assert.equal(h.clips()[0]!.options.duration,400);
 assert.equal(h.calls.find(call=>call.frames[0]?.opacity===0)?.options.delay,80);
 assert.ok(h.calls.every(call=>call.frames[0]?.height===undefined));
 const prefix={...first,text:first.text+'续写后一行'};
 h.transition.update(prefix,true,52);
 assert.equal(h.clips().length,1);
 h.finish();
 assert.equal(h.presented.at(-1),prefix);
 assert.ok(h.calls.every(call=>call.animation.cancelled===1));
});

test('a newly delivered report can open on its first commit while restored prose is immediate',()=>{
 const h=transitionHarness(),report=content('完整报告',{id:'report',arrive:true});
 h.transition.update(report,true);
 assert.equal(h.committed.at(-1),report);
 assert.equal(h.presented.length,0);
 h.finish();
 assert.equal(h.presented.at(-1),report);
 const restored=transitionHarness();
 restored.transition.update({...report,arrive:false},true);
 assert.equal(restored.calls.length,0);
 assert.equal(restored.presented.at(-1)?.id,report.id);
});

test('bursts and streamed suffixes during exit coalesce into the latest paragraph without restarting the exit',()=>{
 const {transition,committed,clips,finish}=transitionHarness(),first=content('首段'),latest=content('第二段已完整收到',{id:'second'});
 transition.update(thinking,true);transition.update(first,true);
 transition.update(content('首段继续追加'),true);transition.update(latest,true);
 assert.equal(clips().length,1);assert.equal(committed.at(-1),thinking);
 finish();assert.equal(committed.at(-1),latest,'no stale intermediate paragraph is replayed');
 transition.update(latest,true);assert.equal(clips().length,2);
 transition.update(content(latest.text+'，继续流入。',{id:'second'}),true);
 assert.equal(clips().length,2,'an entry prefix never restarts either half');
});

test('the first revealed prefix stays intact while later suffixes use their original buffer',()=>{
 const {transition,clips,finish}=transitionHarness(),first='第一段实际收到的正文。';
 transition.update(thinking,true);transition.update(content(first),true);finish();transition.update(content(first),true);finish();
 const painted=[first];let pending:FrameRequestCallback|undefined;
 const reveal=new TextReveal(first,text=>painted.push(text),{request:callback=>{pending=callback;return 1;},cancel:()=>{pending=undefined;},now:()=>0});
 const appended=first+'随后真实收到的追加内容';
 transition.update(content(appended),true);reveal.update(appended,true);
 for(let time=16;time<TEXT_REVEAL_MAX_LAG_MS+16;time+=16){
  const frame=pending;pending=undefined;frame?.(Math.min(time,TEXT_REVEAL_MAX_LAG_MS));
 }
 assert.equal(clips().length,2);assert.ok(painted.every(text=>text.startsWith(first)));assert.equal(painted.at(-1),appended);
});

test('a replacement interrupting a reveal continues from its painted edge and height',()=>{
 const {transition,calls,clips,finish,visual}=transitionHarness(),first=content('第一段'),next=content('新的进展',{id:'second'});
 transition.update(thinking,true,52);transition.update(first,true,52);finish();transition.update(first,true,104);
 const entering=clips().at(-1)!,staleFinish=entering.animation.onfinish!;
 visual.height='74px';transition.update(next,true,104);
 assert.equal(entering.animation.cancelled,1);
 assert.equal(clips().at(-1)!.frames[0]!.clipPath,visual.clipPath);
 assert.equal(calls.at(-2)!.frames[0]!.height,'74px','exit holds the painted height instead of jumping to the intrinsic height');
 staleFinish.call(entering.animation,{} as AnimationPlaybackEvent);
 assert.equal(clips().at(-1)!.animation.cancelled,0);
});

test('waits, errors, hidden pages and reduced motion flush the newest content immediately and never replay on resume',()=>{
 for(const reason of ['waiting','failed','disconnected','hidden','reduced']){
  const {transition,committed,clips}=transitionHarness(),stopped=content(reason,{kind:'status',id:''});
  transition.update(thinking,true);transition.update(content('待显示的进度'),true);
  const exiting=clips()[0]!,staleFinish=exiting.animation.onfinish!;
  transition.update(stopped,false);
  assert.equal(committed.at(-1),stopped,reason);assert.equal(exiting.animation.cancelled,1);
  staleFinish.call(exiting.animation,{} as AnimationPlaybackEvent);assert.equal(committed.at(-1),stopped);
  transition.update(stopped,true);assert.equal(clips().length,1,reason);
 }
});

test('new bindings and unmount invalidate pending text and all old completion callbacks',()=>{
 const {transition,committed,clips}=transitionHarness(),other=content('其他任务的内容',{binding:'other-task'});
 transition.update(thinking,true);transition.update(content('旧任务未提交的内容'),true);
 const old=clips()[0]!,stale=old.animation.onfinish!;
 transition.update(other,true);assert.equal(committed.at(-1),other);
 stale.call(old.animation,{} as AnimationPlaybackEvent);assert.equal(committed.at(-1),other);
 transition.update(content('另一次更新',{binding:'other-task',id:'next'}),true);
 const pending=clips().at(-1)!,late=pending.animation.onfinish!,count=committed.length;
 transition.stop();late.call(pending.animation,{} as AnimationPlaybackEvent);
 assert.equal(committed.length,count);assert.equal(pending.animation.cancelled,1);
});

test('the content surface has one usable copy on initial render, including links and no hidden style',()=>{
 const children=createElement('p',null,'真实文字 ',createElement('a',{href:'https://example.com'},'资源链接'));
 const html=renderToStaticMarkup(createElement(PilotReplyContent,{state:content('真实文字 资源链接'),active:true,children}));
 assert.equal((html.match(/真实文字/g)??[]).length,1);assert.equal((html.match(/<a /g)??[]).length,1);
 assert.match(html,/class="pilot-specialist-reply-content"><div class="pilot-specialist-reply-body"><p>/);
 assert.doesNotMatch(html,/aria-hidden|inert|style=|key=/);
});

const at='2026-11-16T00:00:00Z';
function replyRow():PilotSpecialistRow{
 const worker={id:'worker',roleId:'role',roleName:'检查专员',sessionId:'worker-session',assignmentState:'active',
  task:{taskId:'task',sessionId:'worker-session',projectId:'project',title:'检查任务',state:'running' as const,acceptanceState:'not_evaluated' as const,revision:1,originRootTurnId:'task-origin',deadlineAt:at}};
 return {projectId:'project',worker,activity:{phase:'thinking',label:'正在分析',updatedAt:at},sourceMessageId:'source',sourceCreatedAt:at,reportedTurns:[],
  author:{kind:'specialist',name:worker.roleName,roleId:worker.roleId,workerId:worker.id,sessionId:worker.sessionId,taskId:worker.task.taskId}};
}
function replySnapshot(row:PilotSpecialistRow,text='本次真实公开回复'):SessionSnapshot{
 return {session:{id:row.worker.sessionId,projectId:row.projectId},superagent:{roleId:row.worker.roleId,task:row.worker.task},cursor:1,
  ai:{session:row.worker.sessionId,status:'running',replyStatus:'running',rootTurnId:'current-sdk-root',turnStartedAt:at,cards:text?[{id:'public',type:'message',status:'running',at,content:text,data:{root_turn_id:'current-sdk-root'}}]:[],cardsOffset:0}} as SessionSnapshot;
}
const renderReply=(row:PilotSpecialistRow,snapshot?:SessionSnapshot)=>renderToStaticMarkup(createElement(PilotSpecialistReplyView,{row,snapshot}));

test('a previously delivered exact root does not flash a thinking row before its snapshot reloads',()=>{
 const row={...replyRow(),reportedTurns:['delivered-sdk-root'],observedRootTurnId:'delivered-sdk-root'};
 assert.equal(renderReply(row),'');
 const snapshot=replySnapshot(row);
 const html=renderReply(row,snapshot);
 assert.match(html.replace(/<[^>]*>/g,''),/本次真实公开回复/,'the verified current SDK root takes precedence over the cached delivered root');
 assert.equal((html.match(/pilot-specialist-reply-content/g)??[]).length,1);
 assert.equal(renderReply({...row,reportedTurns:[...row.reportedTurns,'current-sdk-root']},snapshot),'');
 assert.match(renderReply({...row,observedRootTurnId:undefined}),/pilot-specialist-thinking-label/,'a report from an unobserved root cannot retire a fresh binding');
});

test('only a terminal slot with an observed and delivered exact root stops its live subscription',()=>{
 const row={...replyRow(),reportedTurns:['delivered-sdk-root'],observedRootTurnId:'delivered-sdk-root'};
 assert.equal(shouldSubscribePilotReply({...row,continuity:'terminal'}),false);
 assert.equal(shouldSubscribePilotReply({...row,continuity:'updating'}),true,'a temporary activity gap may still receive a new SDK root');
 assert.equal(shouldSubscribePilotReply(row),true,'actual activity resumes even when the former SDK root was already delivered');
 assert.equal(shouldSubscribePilotReply({...row,continuity:'terminal',observedRootTurnId:undefined}),true,'an old report alone cannot prove which invocation ended');
 assert.equal(shouldSubscribePilotReply({...row,continuity:'terminal',observedRootTurnId:'another-root'}),true);
});

test('retained progress stays static and preserves actual waiting or failure hints beside already received prose',()=>{
 const row:PilotSpecialistRow={...replyRow(),activity:{phase:'updating',label:'进度更新中',updatedAt:at},continuity:'updating',observedRootTurnId:'current-sdk-root'};
 for(const text of ['', '已收到的真实正文']){
  const base=replySnapshot(row,text);
  for(const [status,label] of [['waiting_approval','等待确认'],['failed','未完成']] as const){
   const snapshot={...base,ai:{...base.ai!,status,replyStatus:status}} as SessionSnapshot;
   const html=renderReply(row,snapshot),plain=html.replace(/<[^>]*>/g,'');
   assert.match(plain,new RegExp(label));assert.ok(!plain.includes('进度更新中'));
   if(text)assert.ok(plain.includes(text));
   assert.doesNotMatch(html,/data-live-motion="active"|data-live-glow="active"|status-text--active/);
  }
  const terminal={...row,worker:{...row.worker,task:{...row.worker.task,state:'completed' as const}},continuity:'terminal' as const,activity:{...row.activity,label:'执行已结束，正在接收结果'}};
  const html=renderReply(terminal,{...base,ai:{...base.ai!,status:'waiting_approval'}} as SessionSnapshot);
  assert.doesNotMatch(html,/执行已结束，正在接收结果|等待确认|data-live-motion="active"/);
 }
});

test('a retained slot cannot borrow public prose or waiting state from an unrelated new SDK invocation',()=>{
 const row:PilotSpecialistRow={...replyRow(),activity:{phase:'updating',label:'进度更新中',updatedAt:at},continuity:'updating',observedRootTurnId:'previous-sdk-root'};
 const snapshot=replySnapshot(row,'OTHER_INVOCATION_PROSE');snapshot.ai!.status='waiting_approval';
 const html=renderReply(row,snapshot),plain=html.replace(/<[^>]*>/g,'');
 assert.match(plain,/进度更新中/);assert.doesNotMatch(plain,/OTHER_INVOCATION_PROSE|等待确认/);
 assert.doesNotMatch(html,/data-live-motion="active"|data-live-glow="active"/);
});

test('a specialist with visible prose exposes the current human wait beside its process link',()=>{
 const row=replyRow();
 for(const [status,label] of [['waiting_approval','等待确认'],['waiting_input','等待你补充信息']] as const){
  const snapshot=replySnapshot(row);
  snapshot.ai!.status=status;
  const render=(available=true)=>renderToStaticMarkup(createElement(PilotSpecialistReplyView,{row,snapshot,available,onInspectSpecialist:()=>{}}));
  const waiting=render();
  assert.match(waiting,/本次真实公开回复/);
  assert.match(waiting,new RegExp('data-specialist-process="task"[^]*?</button><span role="status">'+label+'</span>'));
  assert.doesNotMatch(waiting,/data-live-motion="active"/);
  assert.doesNotMatch(render(false),new RegExp(label));
  snapshot.ai!.cards=[];
  assert.doesNotMatch(render(),/<\/button><span role="status">/,'the status already occupies the body when no prose has arrived');
 }
});


test('height changes start only with the new paragraph, while entry growth releases stale height but keeps its reveal',()=>{
 const {transition,calls,clips,finish}=transitionHarness();
 transition.update(content('两行过程'),true,52);
 const report=content('完整结论',{id:'report'});
 transition.update(report,true,52);
 assert.deepEqual(calls[0]!.frames.map(frame=>frame.height),['52px','52px'],'exit holds the old layout');
 finish();transition.update(report,true,104);
 const height=calls.find(call=>call.frames[0]?.height==='52px'&&call.frames[1]?.height==='104px')!;
 assert.ok(height);assert.equal(height.options.fill,'none');
 const entry=clips().at(-1)!;
 transition.update({...report,text:report.text+'继续追加'},true,180);
 assert.equal(height.animation.cancelled,1);assert.equal(entry.animation.cancelled,0,'streaming growth does not restart the directional reveal');
 assert.equal(clips().length,2);
 finish();assert.equal(entry.animation.cancelled,1);
});

test('an adopted report keeps attachments and plan projection while stopping working effects',()=>{
 const base=replyRow(),author={...base.author,rootTurnId:'current-sdk-root'};
 const row:PilotSpecialistRow={...base,observedRootTurnId:author.rootTurnId,reportedTurns:[author.rootTurnId],
  finalReport:{id:'formal',sessionId:'pilot/session',role:'assistant',text:'',createdAt:at,author,
   files:[{sourceId:'file/id',name:'核对.txt',text:'sample'}],images:[{id:'img',mimeType:'image/png',base64:'AA==',width:1,height:1,sizeBytes:1}]}};
 const attached=renderReply(row,replySnapshot(row));
 assert.match(attached,/\/api\/sessions\/pilot%2Fsession\/attachments\/file%2Fid/);
 assert.match(attached,/核对.txt/);assert.match(attached,/<img/);
 assert.doesNotMatch(attached,/正在分析|data-live-motion="active"/);
 const plan={...row,finalReport:{...row.finalReport!,text:'<proposed_plan>\nPRIVATE_PLAN_BODY\n</proposed_plan>'}};
 const planned=renderReply(plan,replySnapshot(plan));
 assert.match(planned,/plan-reference/);assert.doesNotMatch(planned,/PRIVATE_PLAN_BODY/);
});
