import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {SessionSnapshot} from '../../shared/contracts';
import type {PilotSpecialistRow} from '../src/pilotSpecialistReplies';
import {PilotSpecialistReplyView,shouldSubscribePilotReply} from '../src/PilotSpecialistConversation';
import {TextReveal} from '../src/textReveal';
import {changesPilotReplyContent,PILOT_REPLY_TRANSITION_MS,PilotReplyContent,PilotReplyContentTransition,type PilotReplyContentState} from '../src/PilotReplyContent';

const content=(text:string,extra:Partial<PilotReplyContentState>={}):PilotReplyContentState=>({binding:'project/role/worker/task/source',kind:'prose',id:'first-card',text,...extra});
const thinking=content('正在抱石琢磨中',{kind:'status',id:''});

function transitionHarness(){
 const calls:{frames:Keyframe[];options:KeyframeAnimationOptions;animation:Animation&{cancelled:number}}[]=[];
 let reads=0;
 const visual={opacity:'0.91',transform:'matrix(1, 0, 0, 1, 0, 0.6)'};
 const surface={animate(frames:Keyframe[],options:KeyframeAnimationOptions){
  const animation={onfinish:null,cancelled:0,cancel(){this.cancelled++;}} as unknown as Animation&{cancelled:number};
  calls.push({frames,options,animation});return animation;
 }};
 const transition=new PilotReplyContentTransition(surface as unknown as HTMLElement,()=>{reads++;return {...visual};});
 return {transition,calls,visual,reads:()=>reads};
}

test('thinking to prose and new progress cards transition, while received prefixes and unchanged snapshots stay steady',()=>{
 const first=content('已经读取主机信息。');
 assert.equal(changesPilotReplyContent(undefined,thinking),false,'initial mount remains fully visible');
 assert.equal(changesPilotReplyContent(thinking,first),true);
 assert.equal(changesPilotReplyContent(first,content(first.text+'接下来检查数据库。')),false,'same card SSE prefixes do not restart');
 assert.equal(changesPilotReplyContent(first,{...first}),false);
 assert.equal(changesPilotReplyContent(first,{...first,id:'second-card'}),false,'a new source id with identical visible content does not replay');
 assert.equal(changesPilotReplyContent(first,content('正在检查数据库。',{id:'second-card'})),true);
 assert.equal(changesPilotReplyContent(first,content('修正后的真实正文。')),true,'same-card non-prefix replacements remain visible and transition');
 assert.equal(changesPilotReplyContent(thinking,content('正在读取文件',{kind:'status',id:''})),true);
 assert.equal(changesPilotReplyContent(first,content('另一个任务的正文',{binding:'another-task'})),false);
});

test('a replacement animates the one existing body without an invisible frame or retained fill',()=>{
 const {transition,calls}=transitionHarness();
 transition.update(thinking,true);assert.equal(calls.length,0);
 transition.update(content('真实公开回复'),true);
 assert.equal(calls.length,1);
 assert.deepEqual(calls[0]!.frames,[{opacity:'0.78',transform:'translateY(2px)'},{opacity:'1',transform:'translateY(0)'}]);
 assert.equal(calls[0]!.options.duration,PILOT_REPLY_TRANSITION_MS);assert.equal(calls[0]!.options.fill,'none');
 const animation=calls[0]!.animation;
 animation.onfinish!.call(animation,{} as AnimationPlaybackEvent);
 assert.equal(animation.cancelled,1);assert.equal(animation.onfinish,null);
});

test('the first public prefix enters prose once and later buffered suffixes never replay or shrink it',()=>{
 const {transition,calls}=transitionHarness(),first='第一段实际收到的正文。';
 transition.update(thinking,true);
 transition.update(content(first),true);
 const painted=[first];let pending:FrameRequestCallback|undefined;
 const reveal=new TextReveal(first,text=>painted.push(text),{request:callback=>{pending=callback;return 1;},cancel:()=>{pending=undefined;},now:()=>0});
 reveal.update(first,true);
 assert.equal(pending,undefined,'the newly mounted prose already contains the complete first received prefix');
 const appended=first+'随后真实收到的追加内容';
 transition.update(content(appended),true);reveal.update(appended,true);
 for(const time of [16,32,80]){const frame=pending;pending=undefined;frame?.(time);}
 assert.equal(calls.length,1,'only thinking to prose transitions; raw prefix appends do not create another status or transition');
 assert.ok(painted.every(text=>text.startsWith(first)),'the first prefix never falls back to an empty or shorter buffered value');
 assert.equal(painted.at(-1),appended);
});

test('rapid progress replacements continue their painted position and detach the old completion callback',()=>{
 const {transition,calls,visual,reads}=transitionHarness();
 transition.update(thinking,true);transition.update(content('第一段'),true);
 const first=calls[0]!.animation,staleFinish=first.onfinish!;
 transition.update(content('新进展',{id:'second-card'}),true);
 assert.equal(reads(),1);assert.deepEqual(calls[1]!.frames[0],visual);
 assert.equal(first.cancelled,1);assert.equal(first.onfinish,null);
 staleFinish.call(first,{} as AnimationPlaybackEvent);
 assert.equal(calls[1]!.animation.cancelled,0,'late callbacks cannot cancel a replacement');
 transition.update(content('新进展继续流入',{id:'second-card'}),true);
 transition.update(content('新进展继续流入',{id:'second-card'}),true);
 assert.equal(calls.length,2,'streaming and polling preserve the ongoing transition');
});

test('waiting, errors, hidden pages and reduced motion cancel immediately and never replay on resume',()=>{
 for(const reason of ['waiting','failed','disconnected','hidden','reduced']){
  const {transition,calls}=transitionHarness();
  transition.update(thinking,true);transition.update(content('已收到的真实正文'),true);
  const stopped=content(reason,{kind:'status',id:''});
  transition.update(stopped,false);
  assert.equal(calls[0]!.animation.cancelled,1,reason);assert.equal(calls[0]!.animation.onfinish,null,reason);
  transition.update(stopped,true);assert.equal(calls.length,1,reason);
  transition.stop();assert.equal(calls[0]!.animation.cancelled,1,'cleanup is idempotent');
 }
});

test('exact binding changes and unmount cleanup cannot carry an old animation into another task',()=>{
 const {transition,calls}=transitionHarness();
 transition.update(thinking,true);transition.update(content('本任务正文'),true);
 transition.update(content('别的任务正文',{binding:'other-project/role/task/source'}),true);
 assert.equal(calls.length,1);assert.equal(calls[0]!.animation.cancelled,1);
 transition.update(content('新的进展',{binding:'other-project/role/task/source',id:'second'}),true);
 transition.stop();assert.equal(calls[1]!.animation.cancelled,1);assert.equal(calls[1]!.animation.onfinish,null);
});

test('the content surface contains exactly one usable copy and no initial hidden style',()=>{
 const children=createElement('p',null,'真实文字 ',createElement('a',{href:'https://example.com'},'资源链接'));
 const html=renderToStaticMarkup(createElement(PilotReplyContent,{state:content('真实文字 资源链接'),active:true,children}));
 assert.equal((html.match(/真实文字/g)??[]).length,1);assert.equal((html.match(/<a /g)??[]).length,1);
 assert.match(html,/class="pilot-specialist-reply-content"><p>/);
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
  const terminal={...row,continuity:'terminal' as const,activity:{...row.activity,label:'执行已结束，正在接收结果'}};
  const html=renderReply(terminal,{...base,ai:{...base.ai!,status:'waiting_approval'}} as SessionSnapshot);
  assert.match(html.replace(/<[^>]*>/g,''),/执行已结束，正在接收结果/);
  assert.doesNotMatch(html,/等待确认|data-live-motion="active"/);
 }
});

test('a retained slot cannot borrow public prose or waiting state from an unrelated new SDK invocation',()=>{
 const row:PilotSpecialistRow={...replyRow(),activity:{phase:'updating',label:'进度更新中',updatedAt:at},continuity:'updating',observedRootTurnId:'previous-sdk-root'};
 const snapshot=replySnapshot(row,'OTHER_INVOCATION_PROSE');snapshot.ai!.status='waiting_approval';
 const html=renderReply(row,snapshot),plain=html.replace(/<[^>]*>/g,'');
 assert.match(plain,/进度更新中/);assert.doesNotMatch(plain,/OTHER_INVOCATION_PROSE|等待确认/);
 assert.doesNotMatch(html,/data-live-motion="active"|data-live-glow="active"/);
});
