import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ReplyIdentity} from '../src/ReplyIdentity';
import {AITranscript} from '../src/AIPanel';
import type {Message,SpecialistReplyAuthor,SessionSnapshot} from '../../shared/contracts';
import {orderedTranscript} from '../src/timeline';
import {isAssistantProse} from '../src/completedTurnProse';

const author=(name:string,id:string):SpecialistReplyAuthor=>({kind:'specialist',name,workerId:'worker-'+id,sessionId:'session-'+id,taskId:'task-'+id});
test('specialist own-session text and message replies both show the role avatar and identity',()=>{
 for(const type of ['text','message'])for(const status of ['running','completed']){
  const at='2026-11-03T00:00:00Z';
  const snapshot={session:{id:'worker'},messages:[],resources:[],actions:[],specialists:[],evidence:[],ai:{session:'worker',status,rootTurnId:'turn',cardsOffset:0,cards:[{id:'answer',type,status,at,content:'实际检查结果。'}]}} as unknown as SessionSnapshot;
  const html=renderToStaticMarkup(createElement(AITranscript,{snapshot,assistantIdentity:{name:'服务运行状态排查专员'}}));
  assert.ok(html.includes('class="response-avatar"'));
  assert.ok(html.includes('<strong>服务运行状态排查专员</strong>'));
  assert.ok(html.includes('实际检查结果。'));
  assert.ok(!html.includes('<strong>Lake</strong>'));
 }
});
test('each delivered report displays its own specialist even inside the Pilot conversation',()=>{
 for(const name of ['Go 审查专员','前端执行专员']){
  const html=renderToStaticMarkup(createElement(ReplyIdentity,{identity:{name:'Pilot',pilot:true},author:author(name,name),onSpecialist(){}}));
  assert.ok(html.includes(`<strong>${name}</strong>`));assert.ok(html.includes(`aria-label="与${name}继续沟通"`));
  assert.ok(!html.includes('<strong>Pilot</strong>')&&!html.includes('<strong>Lake</strong>'));
 }
 const own=renderToStaticMarkup(createElement(ReplyIdentity,{identity:{name:'Pilot',pilot:true}}));
 assert.match(own,/<strong>Pilot<\/strong>/);assert.match(own,/data-role="coordinator"/);
});
test('unattributed ordinary replies retain their own identity',()=>{
 assert.match(renderToStaticMarkup(createElement(ReplyIdentity,{})),/<strong>Lake<\/strong>/);
 assert.match(renderToStaticMarkup(createElement(ReplyIdentity,{identity:{name:'调查专员'}})),/<strong>调查专员<\/strong>/);
});
test('equal reply text cannot erase a different specialist or turn its report into progress prose',()=>{
 const at='2026-11-02T12:00:00Z';
 const messages:Message[]=['Go 审查专员','前端执行专员'].map((name,index)=>({id:'report-'+index,sessionId:'pilot',role:'assistant',text:'same result',createdAt:at,author:author(name,String(index))}));
 const snapshot={session:{id:'pilot'},messages,actions:[],specialists:[],evidence:[],resources:[]} as unknown as SessionSnapshot;
 const entries=orderedTranscript(snapshot,[{id:'pilot-copy',type:'text',status:'completed',at,content:'same result'}],0);
 assert.equal(entries.filter(entry=>entry.message?.author).length,2);
 for(const entry of entries.filter(entry=>entry.message?.author))assert.equal(isAssistantProse(entry),false);
});
