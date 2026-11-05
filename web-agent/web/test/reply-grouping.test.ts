import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {AITranscript} from '../src/AIPanel';
import {pilotReplyContinuations} from '../src/replyGrouping';
import type {TranscriptEntry} from '../src/timeline';
import type {SessionSnapshot,SpecialistReplyAuthor} from '../../shared/contracts';

const at=(n:number)=>`2026-11-05T01:00:0${n}Z`;
const prose=(id:string,n:number):TranscriptEntry=>({id,at:at(n),card:{id,type:'message',status:'completed',at:at(n),content:id}});
const author:SpecialistReplyAuthor={kind:'specialist',name:'知识库专员',workerId:'w',taskId:'t',sessionId:'s'};
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
