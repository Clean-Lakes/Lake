import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {SessionSnapshot,AgentRun} from '../../shared/contracts';
import type {TranscriptEntry} from '../src/timeline';
import {liveTurnProgress} from '../src/liveTurnProgress';
import {AITranscript} from '../src/AIPanel';
import {TurnExecutionDetails} from '../src/TurnExecutionDetails';
import {conversationGroups} from '../src/conversation-progress-model';
const at=(n:number)=>`2026-10-29T01:00:${String(n).padStart(2,'0')}Z`;
const card=(id:string,type:string,content:string,status='completed',n=1):TranscriptEntry=>({id,at:at(n),card:{id,at:at(n),type,content,status,title:type==='operation'?'shell':undefined,data:type==='operation'?{target:'测试主机',arguments:{command:'uptime'}}:undefined}});
const note=card('note','message','先核对原记录。');
const tool=card('tool','operation','PRIVATE TOOL OUTPUT','running',2);
const latest=card('latest','message','正在核对 **服务状态**。\n\n下一步验证连接。','running',3);

test('a single caption uses the newest real narration and preserves source records',()=>{
 const entries=[note,tool,card('thought','thinking','PRIVATE REASONING'),latest,card('next-tool','operation','PRIVATE LATER OUTPUT','running',4)];
 const before=JSON.stringify(entries),progress=liveTurnProgress(entries)!;
 assert.equal(progress.text,'正在核对 服务状态。 下一步验证连接。');
 assert.deepEqual([...progress.ids],['note','latest']);
 assert.equal(JSON.stringify(entries),before);
 assert.ok(!progress.text.includes('PRIVATE'));
});
test('without narration the existing tool label supplies progress, never raw output',()=>{
 const progress=liveTurnProgress([tool])!;
 assert.ok(progress.text.includes('检查系统与资源')||progress.text.includes('执行命令'));
 assert.ok(!progress.text.includes('PRIVATE'));
 assert.equal(progress.ids.size,0);
 for(const status of ['failed','unknown','pending','not_executed','interrupted'])assert.equal(liveTurnProgress([{...tool,card:{...tool.card!,status}}])?.active,false,status);
});
test('plain answers, internal bookkeeping, Pilot and subagent reports keep their own presentation',()=>{
 assert.equal(liveTurnProgress([latest]),undefined);
 for(const name of ['work_begin','work_read','work_update','work_wait','work_finish','__lake_apply_user_supplement','ask_user_question'])assert.equal(liveTurnProgress([note,{...tool,card:{...tool.card!,title:name}}]),undefined);
 assert.equal(liveTurnProgress([note,tool,{id:'child',at:at(4),agentRun:{id:'child'} as AgentRun}]),undefined);
 assert.equal(liveTurnProgress([note,tool,{id:'pilot',at:at(4),sre:{} as NonNullable<TranscriptEntry['sre']>}]),undefined);
});
function snapshot(status='running'):SessionSnapshot{
 return {session:{id:'fixture'},resources:[],actions:[],messages:[{id:'user',sessionId:'fixture',role:'user',text:'检查服务',createdAt:at(0)}],ai:{session:'fixture',status,turnStartedAt:at(0),cardsOffset:0,cards:[note.card!,tool.card!,latest.card!]}} as unknown as SessionSnapshot;
}
test('ordinary running tool turns keep public narration once without a synthesized caption',()=>{
 const current=snapshot();current.ai!.cards.pop();
 const html=renderToStaticMarkup(createElement(AITranscript,{snapshot:current}));
 assert.ok(!html.includes('turn-latest-progress')&&!html.includes('turn-progress-reply')&&!html.includes('过程播报'));
 assert.equal((html.match(/先核对原记录。/g)||[]).length,1);
 assert.ok(!html.includes('is-archived')&&!html.includes('is-awaiting-reply'));
 assert.match(html,/class="settled-reply"><div class="settled-reply-content"><div data-conversation-entry="note"/);
 assert.ok(html.includes('class="turn-execution-details" aria-hidden="true" inert=""'));
});

test('continuous ordinary and Pilot replies never promote reasoning or tool output to public prose',()=>{
 for(const pilot of [false,true])for(const status of ['running','waiting_approval','completed','failed','cancelled']){
  const current=snapshot(status);
  current.ai!.cards.splice(1,0,card('private-reasoning','thinking','PRIVATE REASONING').card!);
  current.ai!.cards.push(card('later-tool','operation','PRIVATE LATER OUTPUT','completed',4).card!);
  const before=JSON.stringify(current);
  const groups=conversationGroups(current.ai!.cards.map(card=>({id:card.id,at:card.at,card})));
  assert.ok(groups.filter(group=>!group.progress).every(group=>group.entries.every(entry=>!entry.card?.content?.includes('PRIVATE'))));
  const html=renderToStaticMarkup(createElement(AITranscript,{snapshot:current,assistantIdentity:{name:pilot?'Pilot':'Lake',pilot}}));
  const details=html.indexOf('class="turn-execution-details"');
  assert.ok(details>0&&html.includes('aria-hidden="true" inert="" role="region" aria-label="执行详细过程"'));
  const body=html.slice(0,details);
  assert.ok(!body.includes('PRIVATE REASONING')&&!body.includes('PRIVATE TOOL OUTPUT')&&!body.includes('PRIVATE LATER OUTPUT'));
  assert.equal((html.match(/先核对原记录。/g)??[]).length,1);
  assert.equal((html.match(/下一步验证连接。/g)??[]).length,1);
  for(const id of ['note','latest'])assert.ok(body.includes('data-conversation-entry="'+id+'"'));
  assert.ok(!html.includes('is-archived')&&!html.includes('turn-progress-reply')&&!html.includes('is-awaiting-reply'));
  assert.ok(html.indexOf('data-conversation-entry="note"')<html.indexOf('data-conversation-entry="latest"'));
  assert.equal(JSON.stringify(current),before,'raw reasoning and tool records remain unchanged for explicit inspection');
 }
});
test('completion restores the real final reply and stops the live caption; failures retain incomplete prose',()=>{
 for(const status of ['completed','failed','cancelled']){
  const s=snapshot(status);s.ai!.cards.forEach(card=>card.status='completed');
  const html=renderToStaticMarkup(createElement(AITranscript,{snapshot:s}));
  assert.ok(!html.includes('turn-latest-progress'),status);
  assert.ok(html.includes('下一步验证连接。'),status);
  assert.ok(html.includes('data-conversation-entry="latest"'),status);
 }
});
test('activity, Plan and a newer plain user turn never inherit the old progress caption',()=>{
 const s=snapshot();
 assert.ok(!renderToStaticMarkup(createElement(AITranscript,{snapshot:s,mode:'activity'})).includes('turn-latest-progress'));
 assert.ok(!renderToStaticMarkup(createElement(AITranscript,{snapshot:{...s,conversationMode:'plan'}})).includes('turn-latest-progress'));
 s.messages.push({id:'new-topic',sessionId:'fixture',role:'user',text:'新话题',createdAt:at(20)});
 assert.ok(!renderToStaticMarkup(createElement(AITranscript,{snapshot:s})).includes('turn-latest-progress'));
});

test('multiple distinct post-tool answers stay in the body, never in a resource stage or caption',()=>{
 for(const status of ['running','completed','failed']){
  const s=snapshot(status);
  s.ai!.cards.splice(2,0,card('actual-first','message','第一项实际核验结果。','completed',3).card!);
  const html=renderToStaticMarkup(createElement(AITranscript,{snapshot:s}));
  for(const id of ['actual-first','latest'])assert.match(html,new RegExp('class="settled-reply"><div class="settled-reply-content"><div data-conversation-entry="'+id+'"'),status+' '+id);
  assert.ok(!html.includes('turn-latest-progress'),'the real reply takes over the caption before turn completion');
 }
});


test('each nonempty public chunk stays in place when another tool starts',()=>{
 for(const content of ['', '  \n']){
  const current=snapshot();current.ai!.cards.at(-1)!.content=content;
  const html=renderToStaticMarkup(createElement(AITranscript,{snapshot:current}));
  assert.ok(!html.includes('turn-latest-progress')&&!html.includes('data-conversation-entry="latest"'),'empty stream packets never create a public reply');
  assert.equal((html.match(/先核对原记录。/g)??[]).length,1);
 }
 const current=snapshot();current.ai!.cards.at(-1)!.content='核';
 const html=renderToStaticMarkup(createElement(AITranscript,{snapshot:current}));
 assert.equal(current.ai!.status,'running');
 assert.ok(!html.includes('turn-latest-progress'));
 assert.match(html,/class="settled-reply"><div class="settled-reply-content"><div data-conversation-entry="latest"/,'first reply chunk keeps its original visible body');
 current.ai!.cards.push(card('next-real-tool','operation','original result','running',4).card!);
 const next=renderToStaticMarkup(createElement(AITranscript,{snapshot:current}));
 assert.ok(!next.includes('turn-latest-progress')&&!next.includes('is-archived'));
 assert.match(next,/class="settled-reply"><div class="settled-reply-content"><div data-conversation-entry="latest"/,'a subsequent tool never hides the former paragraph');
});

// The caption is ordinary text even while the independent timer is active.
test('legacy progress props cannot create another public reply or duplicate a status caption',()=>{
 for(const active of [true,false]){
  const html=renderToStaticMarkup(createElement(TurnExecutionDetails,{details:[],progress:{text:'正在检查服务。',active},view:{status:'running',turnStartedAt:at(0)} as SessionSnapshot['ai']}));
  assert.ok(!html.includes('turn-latest-progress')&&!html.includes('正在检查服务。'));
 }
});
