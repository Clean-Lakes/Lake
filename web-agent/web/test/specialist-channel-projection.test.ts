import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {AICard,SessionSnapshot,SpecialistChannelEntry,SpecialistChannelPage,SuperWorker} from '../../shared/contracts';
import {SpecialistChannelEntries} from '../src/SpecialistChannel';
import {AITranscript} from '../src/AIPanel';
import {channelCardEntryId,liveChannelProse,mergeChannelEntries,mergeChannelPage} from '../src/specialistChannelProjection';

const at='2026-11-06T08:00:00Z';
const worker=(id='a',state:SuperWorker['task']['state']='running'):SuperWorker=>({id,roleId:'role',roleName:'服务器专员',sessionId:`worker-${id}`,assignmentState:state==='running'?'active':'parked',task:{taskId:`task-${id}`,sessionId:`worker-${id}`,title:'检查服务器',state,acceptanceState:'not_evaluated',revision:1,originRootTurnId:`root-${id}`,deadlineAt:''}});
const card=(content='已经读取主机信息',status='running'):AICard=>({id:'same-card-id',at,type:'message',status,content});
const active=(id='a',cards=[card()]):SessionSnapshot=>({session:{id:`worker-${id}`},messages:[],resources:[],actions:[],superagent:{task:worker(id).task},ai:{session:`worker-${id}`,status:'running',turnStartedAt:at,cards,cardsOffset:0}} as SessionSnapshot);
const page=(snapshots:SessionSnapshot[],entries:SpecialistChannelEntry[]=[],workers=snapshots.map(snapshot=>worker(snapshot.session.id.slice(7)))):Pick<SpecialistChannelPage,'active'|'entries'|'workers'>=>({active:snapshots,entries,workers});

test('streaming updates and durable history use the same exact source-card entry identity',()=>{
 const start=active(),original=JSON.stringify(start);
 const first=mergeChannelPage([],page([start]));
 assert.equal(first[0]!.id,'["card","worker-a","same-card-id"]');
 assert.equal(first[0]!.taskId,'task-a');assert.equal(first[0]!.sourceSessionId,'worker-a');
 const second=mergeChannelPage(first,page([active('a',[card('已经读取主机信息，CPU 使用正常')])]));
 assert.equal(second.length,1);assert.equal(second[0]!.id,first[0]!.id);assert.equal(second[0]!.createdAt,first[0]!.createdAt);
 assert.equal(first[0]!.card!.content,'已经读取主机信息','updates cannot mutate already rendered source snapshots');
 const durable={...second[0]!,card:{...second[0]!.card!,status:'completed'}};
 const final=mergeChannelPage(second,page([],[durable],[worker('a','completed')]));
 assert.equal(final.length,1);assert.equal(final[0]!.id,first[0]!.id);assert.equal(final[0]!.card!.status,'completed');
 const html=renderToStaticMarkup(createElement(SpecialistChannelEntries,{entries:final,resources:[]}));
 assert.equal((html.match(/data-channel-entry=/g)??[]).length,1);assert.ok(html.includes('已经读取主机信息，CPU 使用正常'));
 assert.equal(JSON.stringify(start),original);
});

test('a late running snapshot never downgrades a committed final card or merges another worker with equal text and card ID',()=>{
 const first=mergeChannelPage([],page([active('a'),active('b')]));
 assert.equal(first.length,2);assert.notEqual(first[0]!.id,first[1]!.id);
 const finalA={...first.find(entry=>entry.sourceSessionId==='worker-a')!,card:card('已经读取主机信息。检查完成。','completed')};
 const result=mergeChannelPage(first,page([active('a'),active('b')],[finalA],[worker('a','completed'),worker('b')]));
 assert.equal(result.length,2);assert.equal(result.find(entry=>entry.sourceSessionId==='worker-a')!.card!.status,'completed');
 assert.equal(result.find(entry=>entry.sourceSessionId==='worker-b')!.card!.status,'running');
 assert.match(result.find(entry=>entry.sourceSessionId==='worker-a')!.card!.content!,/检查完成/);
});

test('only public nonempty prose from the current invocation enters the shared channel list',()=>{
 const cards=[{...card('previous turn'),id:'previous',at:'2026-11-06T07:00:00Z'},card(''),{...card('private reasoning'),id:'thinking',type:'thinking'},
  {...card('raw tool arguments'),id:'operation',type:'operation'}, {...card('actual error'),id:'error',type:'error',status:'failed'},card('public answer')];
 const entries=liveChannelProse([active('a',cards)]);
 assert.equal(entries.length,1);assert.equal(entries[0]!.card!.content,'public answer');
 assert.deepEqual(liveChannelProse([{...active(),ai:{...active().ai!,turnStartedAt:undefined}}]),[]);
});

test('failed, cancelled and paused invocations retain their prose without inventing a successful final state',()=>{
 const first=mergeChannelPage([],page([active()]));
 for(const state of ['failed','cancelled','paused','blocked'] as const){
  const pending=mergeChannelPage(first,page([],[],[worker('a',state)]));
  assert.equal(pending[0]!.card!.status,'running','missing final metadata must not rewrite the original card status');
  const settled=mergeChannelPage(pending,page([],[{...first[0]!,card:{...first[0]!.card!,status:state}}],[worker('a',state)]));
  assert.equal(settled[0]!.id,first[0]!.id);assert.equal(settled[0]!.card!.content,first[0]!.card!.content);
  assert.equal(settled[0]!.card!.status,state);assert.equal(first[0]!.card!.status,'running');
 }
});

test('loading history and repeated pages preserve streaming identity and original user roles',()=>{
 const live=mergeChannelPage([],page([active()]));
 const user:SpecialistChannelEntry={id:'original-user',sourceSessionId:'channel',createdAt:'2026-11-06T07:00:00Z',message:{id:'u',sessionId:'channel',role:'user',text:'已经读取主机信息',createdAt:'2026-11-06T07:00:00Z'}};
 const older:SpecialistChannelEntry={id:channelCardEntryId('worker-old','same-card-id'),sourceSessionId:'worker-old',createdAt:'2026-11-06T07:01:00Z',card:{...card('历史独立答案','completed'),at:'2026-11-06T07:01:00Z'}};
 const paged=mergeChannelEntries(live,[user,older]);
 const repeated=mergeChannelPage(paged,page([active()],[user,older]));
 assert.equal(repeated.length,3);assert.equal(repeated.at(-1)!.id,live[0]!.id);
 assert.equal(repeated[0]!.message!.role,'user');assert.notEqual(repeated[1]!.id,repeated[2]!.id);
});

test('the activity transcript retains a real error without painting the shared prose a second time',()=>{
 const snapshot=active('a',[card('已经读取一部分信息'),{id:'failure',at:'2026-11-06T08:00:01Z',type:'error',status:'failed',content:'连接意外中断，请检查网络。'}]);
 const entries=mergeChannelPage([],page([snapshot]));
 const html=renderToStaticMarkup(createElement('div',null,
  createElement(SpecialistChannelEntries,{entries,resources:[],activeSources:new Set([snapshot.session.id])}),
  createElement(AITranscript,{snapshot,proseInChannel:true,assistantIdentity:{name:'服务器专员'}})));
 assert.equal((html.match(/已经读取一部分信息/g)??[]).length,1);
 assert.ok(html.includes('连接意外中断，请检查网络。'));
});

test('specialist plans render one reference through streaming and settlement without mounting the plan body',()=>{
 const content='<proposed_plan>\n# CHANNEL_PLAN_BODY\n1. CHANNEL_PRIVATE_STEP\n</proposed_plan>';
 const snapshot={...active('a',[card(content)]),conversationMode:'plan'} as SessionSnapshot;
 const original=JSON.stringify(snapshot);
 const entries=mergeChannelPage([],page([snapshot]));
 const html=renderToStaticMarkup(createElement('div',null,
  createElement(SpecialistChannelEntries,{entries,resources:[],activeSources:new Set([snapshot.session.id]),activeSnapshots:new Map([[snapshot.session.id,snapshot]])}),
  createElement(AITranscript,{snapshot,proseInChannel:true,assistantIdentity:{name:'服务器专员'}})));
 assert.equal((html.match(/aria-label="计划状态"/g)??[]).length,1);
 assert.match(html,/正在生成计划/);
 assert.doesNotMatch(html,/CHANNEL_PLAN_BODY|CHANNEL_PRIVATE_STEP|proposed_plan/);
 const final={...entries[0]!,card:{...entries[0]!.card!,status:'completed',data:{proposedPlan:true}}};
 const settled=mergeChannelPage(entries,page([],[final],[worker('a','completed')]));
 const ended=renderToStaticMarkup(createElement(SpecialistChannelEntries,{entries:settled,resources:[],activeSources:new Set()}));
 assert.equal((ended.match(/aria-label="计划状态"/g)??[]).length,1);
 assert.match(ended,/计划已保存/);assert.doesNotMatch(ended,/CHANNEL_PLAN_BODY|CHANNEL_PRIVATE_STEP|proposed_plan/);
 assert.equal(settled[0]!.id,entries[0]!.id);
 assert.equal(JSON.stringify(snapshot),original,'the plan projection must not rewrite source history');
});

test('streamed plan prefixes and source-scoped plan metadata use the channel projection',()=>{
 for(const content of ['<','<proposed_','<proposed_plan>\nCHANNEL_PRIVATE_STEP']){
  const snapshot={...active('a',[card(content)]),conversationMode:'plan'} as SessionSnapshot;
  const entries=mergeChannelPage([],page([snapshot]));
  const html=renderToStaticMarkup(createElement(SpecialistChannelEntries,{entries,resources:[],activeSnapshots:new Map([[snapshot.session.id,snapshot]])}));
  assert.match(html,/正在生成计划/);assert.doesNotMatch(html,/CHANNEL_PRIVATE_STEP|&lt;proposed_/);
 }
 const snapshot=active('a',[card('CHANNEL_PRIVATE_STEP')]);
 snapshot.ai!.proposedPlan={id:'same-card-id',at,content:'CHANNEL_PRIVATE_STEP'};
 const other=active('b',[card('另一位专员的普通回答')]);
 const html=renderToStaticMarkup(createElement(SpecialistChannelEntries,{entries:mergeChannelPage([],page([snapshot,other])),resources:[],activeSnapshots:new Map([[snapshot.session.id,snapshot],[other.session.id,other]])}));
 assert.equal((html.match(/aria-label="计划状态"/g)??[]).length,1);
 assert.match(html,/计划已保存/);assert.match(html,/另一位专员的普通回答/);assert.doesNotMatch(html,/CHANNEL_PRIVATE_STEP/);
});

test('saved and incomplete legacy plans stay out of channel prose without reclassifying user messages',()=>{
 const content='<proposed_plan>\nCHANNEL_LEGACY_BODY\n</proposed_plan>';
 const message:SpecialistChannelEntry={id:'legacy-message',sourceSessionId:'worker-old',createdAt:at,message:{id:'m',sessionId:'worker-old',role:'assistant',text:content,createdAt:at}};
 const draft:SpecialistChannelEntry={id:channelCardEntryId('worker-a','draft'),sourceSessionId:'worker-a',createdAt:at,card:{...card('<proposed_plan>\nCHANNEL_UNFINISHED_BODY','failed'),id:'draft'}};
 const user:SpecialistChannelEntry={...message,id:'user',message:{...message.message!,id:'user',role:'user',text:'请说明 <proposed_plan> 的含义'}};
 const html=renderToStaticMarkup(createElement(SpecialistChannelEntries,{entries:[message,draft,user],resources:[]}));
 assert.equal((html.match(/aria-label="计划状态"/g)??[]).length,2);
 assert.match(html,/计划未完成/);assert.match(html,/请说明/);assert.match(html,/ai-role-user/);
 assert.doesNotMatch(html,/CHANNEL_LEGACY_BODY|CHANNEL_UNFINISHED_BODY/);
});
