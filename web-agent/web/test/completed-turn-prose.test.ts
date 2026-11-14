import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {AICard, AgentRun, Resource, SessionSnapshot} from '../../shared/contracts';
import type {TranscriptEntry} from '../src/timeline';
import {completedTurnInterimIds,trailingTurnReplyId} from '../src/completedTurnProse';
import {resourceStageProgress} from '../src/resourceStageProgress';
import {conversationGroups} from '../src/conversation-progress-model';
import {AITranscript} from '../src/AIPanel';

const card = (id: string, type: string, content = id): TranscriptEntry => ({id, at: '2026-10-21T00:00:01Z', card: {id, at: '2026-10-21T00:00:01Z', type, content, status: 'completed'}});
const turn = [card('interim', 'message', '先核对测试节点。'), card('tool', 'operation'), card('final', 'message', '最终结果：测试服务正常。')];
const mainReply=(html:string)=>html.split(/<div[^>]*class="turn-execution-details/)[0]!;

test('a streaming reply after tools stays in the main body until another tool proves it interim',()=>{
 const resource={id:'host',name:'测试主机',kind:'local'} as Resource;
 const tool=card('check','operation');tool.card!.title='inspect_host';tool.card!.data={resource_id:resource.id};
 const reply=card('answer','message','测试主机运行正常。');reply.card!.status='running';
 const entries=[tool,reply];
 const id=trailingTurnReplyId(entries);
 assert.equal(id,'answer');
 assert.equal(resourceStageProgress(entries,conversationGroups(entries,[resource]),true,false,id).ids.has('answer'),false);
 reply.card!.status='completed';
 assert.equal(trailingTurnReplyId(entries),'answer','completion must not move the same node back into progress');
 const next=card('next','operation');next.card!.data={resource_id:resource.id};
 assert.equal(trailingTurnReplyId([...entries,next]),undefined);
 assert.equal(resourceStageProgress([...entries,next],conversationGroups([...entries,next],[resource]),true,false).ids.has('answer'),true);
 assert.equal(trailingTurnReplyId([...entries,card('failure','error')]),undefined);
});

test('completed tool turns archive only narration before the real final response', () => {
  assert.deepEqual([...completedTurnInterimIds(turn, true)], ['interim']);
  assert.equal(completedTurnInterimIds(turn, false).size, 0, 'live, failed, stopped and waiting turns keep partial prose');
  const streaming=turn.map(entry=>entry.id==='final'?{...entry,card:{...entry.card!,status:'running'}}:entry);
  assert.deepEqual([...completedTurnInterimIds(streaming,false,'final')],['interim'],'retire the visible process before revealing its live answer');
  assert.equal(completedTurnInterimIds(turn.slice(0, 2), true).size, 0, 'no model final means no invented summary');
  assert.equal(completedTurnInterimIds([turn[0]!, turn[2]!], true).size, 0, 'ordinary conversation stays intact');
  assert.equal(completedTurnInterimIds([...turn, card('error', 'error')], true).size, 0, 'a later failure cannot be presented as completed');
  assert.equal(completedTurnInterimIds([...turn, {id:'role',at:'now',agentRun:{id:'role'} as AgentRun}], true).size, 0, 'role reports retain their own identity');
});

test('a real tool reply replaces pre-tool narration in the body and preserves it in closed details', () => {
  const cards = turn.map(entry => entry.card!) as AICard[];
  const snapshot = {session: {id: 'fixture'}, messages: [{id: 'user', role: 'user', text: '检查测试服务', createdAt: '2026-10-21T00:00:00Z'}], actions: [], ai: {status: 'completed', cards, cardsOffset: 0}} as unknown as SessionSnapshot;
  const html = renderToStaticMarkup(createElement(AITranscript, {snapshot}));
  assert.ok(!html.includes('过程播报')&&!html.includes('is-archived')&&!html.includes('is-awaiting-reply'));
  assert.match(html,/class="settled-reply"><div class="settled-reply-content"><div data-conversation-entry="final"/);
  assert.match(html,/data-conversation-entry="interim" class="turn-process-prose reply-process-text"/);
  assert.equal((html.match(/先核对测试节点。/g)??[]).length,1);
  assert.ok(html.indexOf('data-conversation-entry="interim"')>html.indexOf('aria-label="执行详细过程"'),'narration belongs to execution details');
  const live = renderToStaticMarkup(createElement(AITranscript, {snapshot: {...snapshot, ai: {...snapshot.ai!, status: 'running'}}}));
  assert.ok(!live.includes('is-archived')&&!live.includes('过程播报')&&!live.includes('is-awaiting-reply'));
  for(const text of ['先核对测试节点。','最终结果：测试服务正常。'])assert.equal((live.split(text).length-1),1);
  assert.ok(!live.includes('turn-execution-details is-open'),'operation details stay closed until the reader opens them');
  assert.equal(renderToStaticMarkup(createElement(AITranscript,{snapshot:structuredClone(snapshot)})),html,'an unchanged restored snapshot does not switch prose projection');
  const activity = renderToStaticMarkup(createElement(AITranscript, {snapshot, mode: 'activity'}));
  assert.ok(!activity.includes('is-archived'));
});


test('an incomplete turn with a real post-tool answer archives only proven pre-tool narration',()=>{
 const failure=card('failure','error','实际操作失败');failure.card!.status='failed';
 const second=card('second','message','补充核验：客户端实际登录仍需确认。');
 const ended=[turn[0]!,turn[1]!,turn[2]!,second,failure];
 assert.deepEqual([...completedTurnInterimIds(ended,false,undefined,true)],['interim']);
 assert.equal(completedTurnInterimIds(ended,false,undefined,true).has('final'),false);
 assert.equal(completedTurnInterimIds(ended,false,undefined,true).has('second'),false,'distinct actual results must not be semantically deduplicated');
 assert.equal(completedTurnInterimIds(ended.slice(0,2),false,undefined,true).size,0,'without a later actual answer incomplete narration remains visible');
 const partial=[turn[0]!,turn[1]!,{...turn[2]!,card:{...turn[2]!.card!,status:'failed'}}];
 assert.deepEqual([...completedTurnInterimIds(partial,false,undefined,true)],['interim'],'retain the later partial answer while retiring only its pre-tool narration');
 const snapshot={session:{id:'fixture'},resources:[],actions:[],messages:[{id:'user',role:'user',text:'继续处理',createdAt:'2026-10-21T00:00:00Z'}],replyTimings:[{messageId:'user',startedAt:'2026-10-21T00:00:00Z',finishedAt:'2026-10-21T00:00:05Z',status:'failed'}],ai:{session:'fixture',status:'failed',cardsOffset:0,cards:ended.map(entry=>entry.card!)}} as unknown as SessionSnapshot;
 const html=renderToStaticMarkup(createElement(AITranscript,{snapshot}));
 assert.ok(html.includes('未完成')&&html.includes('实际操作失败'));
 assert.ok(!html.includes('过程播报')&&!html.includes('is-archived'));
 for(const id of ['final','second'])assert.match(html,new RegExp('class="settled-reply"><div class="settled-reply-content"><div data-conversation-entry="'+id+'"'));
 assert.match(html,/data-conversation-entry="interim" class="turn-process-prose reply-process-text"/);
 assert.equal((html.match(/先核对测试节点。/g)??[]).length,1);
});

test('specialist creation and executor changes show only their actual result, including the first streamed chunk and restored history',()=>{
 for(const [before,after,action] of [
  ['我来创建 K8s 专员，负责处理 Kubernetes 相关任务。','已创建 K8s 专员，当前使用 Lake 原生 Agent。','create'],
  ['我把 K8s 专员的 Agent 改为 Codex。','已将 K8s 专员的 Agent 改为 Codex。','update'],
 ])for(const status of ['running','completed']){
  const entries=[card('before','message',before),card('tool','operation','{"ok":true}'),card('after','message',after)];
  entries.forEach((entry,index)=>{entry.at=entry.card!.at=`2026-11-13T00:00:0${index+1}Z`;entry.card!.data={root_turn_id:'root',...(index===1?{arguments:{action}}:{})}});
  entries[1]!.card!.title='manage_specialist';entries[2]!.card!.status=status;
  const snapshot={session:{id:'pilot'},messages:[{id:'user',role:'user',text:'配置专员',createdAt:'2026-11-13T00:00:00Z'}],resources:[],actions:[],ai:{status,rootTurnId:'root',cardsOffset:0,cards:entries.map(entry=>entry.card!)}} as unknown as SessionSnapshot;
  const original=JSON.stringify(snapshot);
  const html=renderToStaticMarkup(createElement(AITranscript,{snapshot,assistantIdentity:{name:'Pilot',pilot:true}}));
  assert.ok(mainReply(html).includes(after)&&!mainReply(html).includes(before));
  assert.match(mainReply(html),/data-conversation-entry="after" class="ai-response"/,'the actual reply has its own visible identity');
  assert.match(html,/data-conversation-entry="before" class="turn-process-prose reply-process-text"/);
  assert.equal(html.split(before).length-1,1,'the original narration exists once, in the closed details');
  assert.ok(!html.includes('turn-execution-details is-open'));
  assert.equal(renderToStaticMarkup(createElement(AITranscript,{snapshot:structuredClone(snapshot),assistantIdentity:{name:'Pilot',pilot:true}})),html);
  assert.equal(JSON.stringify(snapshot),original,'display projection never edits saved replies or tool receipts');
 }
});

test('narration cannot retire across execution roots, unknown bindings, user turns or specialist reports',()=>{
 const bound=turn.map(entry=>({...entry,card:{...entry.card!,data:{root_turn_id:'root'}}}));
 assert.deepEqual([...completedTurnInterimIds(bound,true)],['interim']);
 for(const data of [{root_turn_id:'different-root'},undefined]){
  const mixed=bound.map(entry=>entry.id==='final'?{...entry,card:{...entry.card!,data}}:entry);
  assert.equal(completedTurnInterimIds(mixed,true).size,0,'a later reply with a different or missing root is not this operation’s result');
 }
 const report:TranscriptEntry={id:'report',at:'now',message:{id:'report',sessionId:'worker',role:'assistant',text:'专员独立报告',createdAt:'now',author:{kind:'specialist',name:'K8s 专员',workerId:'worker',sessionId:'worker',roleId:'k8s'}}};
 assert.equal(completedTurnInterimIds([bound[0]!,bound[1]!,report,bound[2]!],true).size,0);
 const user=(id:string):TranscriptEntry=>({id,at:'now',message:{id,sessionId:'pilot',role:'user',text:'继续',createdAt:'now'}});
 assert.equal(completedTurnInterimIds([user('first'),...bound,user('next')],true).size,0);
});

test('without an actual post-tool result, stopped or empty replies retain the available partial explanation',()=>{
 for(const ending of ['', '  \n']){
  const entries=[turn[0]!,turn[1]!,card('empty','message',ending)];
  assert.equal(completedTurnInterimIds(entries,true).size,0);
  assert.equal(completedTurnInterimIds(entries,false,undefined,true).size,0);
 }
 const question=card('question','operation');question.card!.title='ask_user_question';
 assert.equal(completedTurnInterimIds([turn[0]!,question,turn[2]!],true).size,0,'questions are user interactions, not proof of a completed operation');
});
