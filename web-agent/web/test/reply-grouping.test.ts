import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {AITranscript} from '../src/AIPanel';
import {pilotReplyContinuations,replyRoleBreaks} from '../src/replyGrouping';
import type {TranscriptEntry} from '../src/timeline';
import type {SessionSnapshot,SpecialistReplyAuthor} from '../../shared/contracts';

const at=(n:number)=>`2026-11-05T01:00:0${n}Z`;
const prose=(id:string,n:number):TranscriptEntry=>({id,at:at(n),card:{id,type:'message',status:'completed',at:at(n),content:id}});
const author:SpecialistReplyAuthor={kind:'specialist',name:'知识库专员',workerId:'w',taskId:'t',sessionId:'s'};

test('extra role spacing follows exact sender changes while preserving same-role task replies',()=>{
 const report=(id:string,n:number,roleId:string,workerId=id):TranscriptEntry=>({id,at:at(n),message:{id,sessionId:'pilot',role:'assistant',text:id,createdAt:at(n),author:{...author,roleId,workerId}}});
 const entries=[prose('pilot-first',1),prose('pilot-continued',2),report('role-a',3,'a'),report('same-role-new-task',4,'a'),report('role-b-same-name',5,'b'),prose('pilot-return',6)];
 const original=JSON.stringify(entries);
 assert.deepEqual([...replyRoleBreaks(entries,new Set())],['role-a','role-b-same-name','pilot-return']);
 assert.deepEqual([...replyRoleBreaks(entries,new Set(['role-b-same-name']),new Set(['same-role-new-task']))],['role-a','pilot-return']);
 assert.equal(JSON.stringify(entries),original);
});

test('Pilot-to-specialist and specialist-to-Pilot boundaries receive spacing without duplicating identities',()=>{
 const messages=[{id:'user',sessionId:'pilot',role:'user',text:'检查',createdAt:at(0)},
  {id:'pilot',sessionId:'pilot',role:'assistant',text:'已安排检查。',createdAt:at(1)},
  {id:'report',sessionId:'pilot',role:'assistant',text:'这是实际结果。',createdAt:at(2),author:{...author,roleId:'role'}},
  {id:'pilot-return',sessionId:'pilot',role:'assistant',text:'收到检查结果。',createdAt:at(3)}];
 const snapshot={session:{id:'pilot'},resources:[],actions:[],specialists:[],evidence:[],messages} as SessionSnapshot;
 const html=renderToStaticMarkup(createElement(AITranscript,{snapshot,assistantIdentity:{name:'Pilot',pilot:true},onSpecialist(){}}));
 assert.equal((html.match(/is-role-break/g)??[]).length,2);
 assert.equal((html.match(/aria-label="与知识库专员继续沟通"/g)??[]).length,1);
 for(const text of messages.map(message=>message.text))assert.ok(html.includes(text));
});
test('Pilot sender grouping preserves text and stops at tools, errors, users and authored reports',()=>{
 const first=prose('first',1),second=prose('second',2);
 assert.deepEqual([...pilotReplyContinuations([first,second],new Set())],['second']);
 const boundaries:TranscriptEntry[]=[
  {id:'tool',at:at(3),card:{id:'tool',at:at(3),type:'operation',status:'completed'}},
  {id:'error',at:at(3),card:{id:'error',at:at(3),type:'error',status:'failed',content:'未执行'}},
  {id:'user',at:at(3),message:{id:'user',sessionId:'pilot',role:'user',text:'新要求',createdAt:at(3)}},
  {id:'report',at:at(3),message:{id:'report',sessionId:'pilot',role:'assistant',text:'first',author,createdAt:at(3)}},
 ];
 for(const boundary of boundaries)assert.equal(pilotReplyContinuations([first,boundary,second],new Set()).size,0);
});
test('an archived first reply cannot remove the visible final reply identity',()=>{
 const entries=[prose('archived',1),prose('answer',2),prose('continuation',3)];
 assert.deepEqual([...pilotReplyContinuations(entries,new Set(['archived']))],['continuation']);
});
test('only process entries explicitly absent from the body can bridge a Pilot author group',()=>{
 const first=prose('first',1),last=prose('last',4),tool:TranscriptEntry={id:'tool',at:at(2),card:{id:'tool',at:at(2),type:'operation',status:'completed'}};
 assert.deepEqual([...pilotReplyContinuations([first,tool,last],new Set(),new Set(['tool']))],['last']);
 const error:TranscriptEntry={id:'error',at:at(3),card:{id:'error',at:at(3),type:'error',status:'failed',content:'实际错误'}};
 assert.equal(pilotReplyContinuations([first,tool,error,last],new Set(),new Set(['tool'])).size,0);
});

test('hidden tools, reasoning, empty packets and Pilot dispatch keep one visible author without changing prose identity',()=>{
 const texts=['我查一下服务器。','已安排专员检查。'];
 for(const status of ['running','completed']){
  const snapshot={session:{id:'pilot'},resources:[],actions:[],messages:[{id:'user',sessionId:'pilot',role:'user',text:'检查服务器',createdAt:at(0)},
   {id:'dispatch',sessionId:'pilot',role:'assistant',text:'内部派发记录',createdAt:at(3),dispatch:{id:'dispatch',sourceMessageId:'user',workerId:'w',sessionId:'worker',taskId:'task',roleId:'role',roleName:'运维专员',instruction:'检查服务器',action:'create'}}],
   ai:{session:'pilot',status,cardsOffset:0,cards:[{...prose('first',1).card!,content:texts[0]},
    {id:'tool',at:at(2),type:'operation',title:'route_work',status:'completed'},
    {id:'thought',at:at(3),type:'thinking',status:'completed',content:'不公开的思考'},
    {id:'empty',at:at(3),type:'message',status:'running',content:''},
    {...prose('last',4).card!,status,content:texts[1]}]}} as SessionSnapshot;
  const before=JSON.stringify(snapshot),html=renderToStaticMarkup(createElement(AITranscript,{snapshot,assistantIdentity:{name:'Pilot',pilot:true}}));
  assert.equal((html.match(/<strong>Pilot<\/strong>/g)??[]).length,1,status);
  assert.match(html,/data-conversation-entry="last" class="ai-response is-reply-continuation"/);
  assert.ok(html.includes('data-conversation-entry="first"')&&html.includes('data-conversation-entry="last"'));
  assert.ok(!html.includes('内部派发记录'));
  for(const text of texts)assert.equal(html.split(text).length-1,1);
  assert.equal(JSON.stringify(snapshot),before);
 }
});

test('real errors, confirmation and specialist authors still separate visible Pilot replies',()=>{
 const boundaries:TranscriptEntry[]=[
  {id:'error',at:at(2),card:{id:'error',at:at(2),type:'error',status:'failed',content:'实际执行失败'}},
  ...['failed','pending','unknown'].map(status=>({id:status,at:at(2),card:{id:status,at:at(2),type:'operation',title:'inspect_host',status}})),
  {id:'question',at:at(2),card:{id:'question',at:at(2),type:'operation',title:'ask_user_question',status:'completed'}},
  {id:'report',at:at(2),message:{id:'report',sessionId:'pilot',role:'assistant',text:'专员报告',author,createdAt:at(2)}},
 ];
 for(const boundary of boundaries){
  const snapshot={session:{id:'pilot'},resources:[],actions:[],messages:[{id:'user',sessionId:'pilot',role:'user',text:'检查服务器',createdAt:at(0)},...(boundary.message?[boundary.message]:[])],
   ai:{session:'pilot',status:'completed',cardsOffset:0,cards:[prose('first',1).card!,...(boundary.card?[boundary.card]:[]),prose('last',4).card!]}} as SessionSnapshot;
  const html=renderToStaticMarkup(createElement(AITranscript,{snapshot,assistantIdentity:{name:'Pilot',pilot:true},onSpecialist(){}}));
  const narrationRetired=boundary.card?.type==='operation'&&boundary.card.title!=='ask_user_question';
  assert.equal((html.match(/<strong>Pilot<\/strong>/g)??[]).length,narrationRetired?1:2,boundary.id);
  assert.ok(!html.includes('data-conversation-entry="last" class="ai-response is-reply-continuation"'),boundary.id);
  if(narrationRetired)assert.match(html,/data-conversation-entry="first" class="turn-process-prose reply-process-text"/);
  if(boundary.card?.type==='operation'&&boundary.card.status!=='completed')assert.ok(html.includes('thinking-timeline'),'real operation attention remains available');
 }
});
test('streaming and restored Pilot replies group without changing messages or specialist navigation',()=>{
 for(const persisted of [false,true])for(const status of ['running','completed']){
  const text=['我查一下知识库专员的统计结果。','南京-运维组共有 62 个已发布文档。'];
  const snapshot={session:{id:'pilot'},resources:[],actions:[],specialists:[],evidence:[],messages:[{id:'user',sessionId:'pilot',role:'user',text:'运维组多少文档呢',createdAt:at(0)},...(persisted?text.map((value,n)=>({id:'reply-'+n,sessionId:'pilot',role:'assistant',text:value,createdAt:at(n+1)})):[])],ai:{session:'pilot',status,rootTurnId:'turn',cardsOffset:0,cards:persisted?[]:text.map((value,n)=>({id:'reply-'+n,type:'message',status:n===0?'completed':status,at:at(n+1),content:value}))}} as SessionSnapshot;
  const before=JSON.stringify(snapshot);
  const html=renderToStaticMarkup(createElement(AITranscript,{snapshot,assistantIdentity:{name:'Pilot',pilot:true}}));
  // A live waiting indicator has its own CSS-hidden identity label. Count
  // ended headers, and always require the actual continuation's hidden label.
  if(status==='completed')assert.equal((html.match(/<strong>Pilot<\/strong>/g)||[]).length,1);
  assert.ok(html.includes('class="reply-continued-author">Pilot</span>'));
  assert.ok(html.includes('is-reply-continuation'));
  for(const value of text)assert.ok(html.includes(value));
  assert.equal(JSON.stringify(snapshot),before);
  const normal=renderToStaticMarkup(createElement(AITranscript,{snapshot,assistantIdentity:{name:'普通会话'}}));
  assert.ok(!normal.includes('is-reply-continuation'));
 }
 const reports={session:{id:'pilot'},resources:[],actions:[],specialists:[],evidence:[],messages:[1,2].map(n=>({id:'report-'+n,sessionId:'pilot',role:'assistant',text:'相同的结果',createdAt:at(n),author:{...author,taskId:'task-'+n,workerId:'worker-'+n}}))} as SessionSnapshot;
 const html=renderToStaticMarkup(createElement(AITranscript,{snapshot:reports,assistantIdentity:{name:'Pilot',pilot:true},onSpecialist(){}}));
 assert.equal((html.match(/aria-label="与知识库专员继续沟通"/g)||[]).length,2);
 assert.ok(!html.includes('is-reply-continuation'));
});
