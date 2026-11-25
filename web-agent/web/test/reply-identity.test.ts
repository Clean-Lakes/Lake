import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ReplyIdentity} from '../src/ReplyIdentity';
import {AITranscript} from '../src/AIPanel';
import type {Message,SpecialistReplyAuthor,SessionSnapshot} from '../../shared/contracts';
import {orderedTranscript} from '../src/timeline';
import {isAssistantProse} from '../src/completedTurnProse';
import {pilotIdentity,superWorkerIcon} from '../src/superAgentPresentation';

const author=(name:string,id:string):SpecialistReplyAuthor=>({kind:'specialist',name,roleId:'role-'+id,workerId:'worker-'+id,sessionId:'session-'+id,taskId:'task-'+id});
test('a legacy session-only author link names the record it can open',()=>{
 const old={...author('旧专员','old'),taskId:undefined};
 const html=renderToStaticMarkup(createElement(ReplyIdentity,{author:old,onSpecialist(){}}));
 assert.match(html,/aria-label="查看旧专员的记录"/);
});
test('specialist own-session replies omit repeated identity headers and chat avatars',()=>{
 for(const type of ['text','message'])for(const status of ['running','completed'])for(const persisted of [false,true]){
  const at='2026-11-03T00:00:00Z';
  const snapshot={session:{id:'worker',workspaceRole:'worker'},messages:persisted?[{id:'stored',role:'assistant',text:'实际检查结果。',createdAt:at}]:[],resources:[],actions:[],specialists:[],evidence:[],ai:{session:'worker',status,rootTurnId:'turn',cardsOffset:0,cards:persisted?[]:[{id:'answer',type,status,at,content:'实际检查结果。'}]}} as unknown as SessionSnapshot;
  const html=renderToStaticMarkup(createElement(AITranscript,{snapshot,assistantIdentity:{name:'服务运行状态排查专员'}}));
  assert.ok(!html.includes('class="response-avatar"')&&!html.includes('class="response-identity'));
  assert.ok(!html.includes('<strong>服务运行状态排查专员</strong>'));
  assert.ok(html.includes('实际检查结果。'));
  assert.ok(!html.includes('<strong>Lake</strong>'));
 }
});
test('each delivered report displays its own specialist even inside the Pilot conversation',()=>{
 for(const name of ['Go 审查专员','前端执行专员']){
  const html=renderToStaticMarkup(createElement(ReplyIdentity,{identity:pilotIdentity,author:author(name,name),onSpecialist(){}}));
  assert.ok(html.includes(`<strong>${name}</strong>`));assert.ok(html.includes(`aria-label="查看${name}的任务记录"`));
  assert.match(html,/class="response-avatar"/);
  assert.ok(html.includes(`data-role="${superWorkerIcon({roleId:author(name,name).roleId,roleName:name})}"`));
  assert.doesNotMatch(html,/data-role="coordinator"/);
  assert.ok(!html.includes('<strong>Pilot</strong>')&&!html.includes('<strong>Lake</strong>'));
 }
 const own=renderToStaticMarkup(createElement(ReplyIdentity,{identity:pilotIdentity}));
 assert.match(own,/<strong>Lake<\/strong>/);assert.match(own,/data-role="coordinator"/);
});
test('unattributed ordinary replies retain their own identity',()=>{
 assert.match(renderToStaticMarkup(createElement(ReplyIdentity,{})),/<strong>Lake<\/strong>/);
 assert.match(renderToStaticMarkup(createElement(ReplyIdentity,{identity:{name:'调查专员'}})),/<strong>调查专员<\/strong>/);
});
test('name motion opts in only the live specialist name while its logo, avatar and navigation stay outside',()=>{
 const specialist={...author('数据库👩🏽‍💻核对专员','db'),execution:{kind:'acp' as const,agent:'codex' as const}};
 const render=(nameMotion:boolean)=>renderToStaticMarkup(createElement(ReplyIdentity,{identity:pilotIdentity,author:specialist,nameMotion,onSpecialist(){}}));
 const active=render(true),still=render(false),name=active.match(/<strong>([\s\S]*?)<\/strong>/)?.[1]??'';
 assert.match(name,/class="live-text-motion-label reply-author-name-motion"/);
 assert.match(name,/data-live-motion="active"/);assert.match(name,/data-live-glow="active"/);
 assert.equal(name.replace(/<[^>]*>/g,''),specialist.name);
 assert.doesNotMatch(name,/response-avatar|agent-backend-logo|<svg|<button/);
 assert.match(active,/<\/strong><span[^>]*agent-backend-logo/,'the real Agent logo is a sibling of the decorated name');
 assert.match(active,/<button type="button" class="response-author"/);
 assert.ok(active.includes(`aria-label="查看${specialist.name}的任务记录 · Agent 类型：Codex"`));
 assert.equal(active.replaceAll('data-live-motion="active"','data-live-motion="still"').replaceAll('data-live-glow="active"','data-live-glow="still"'),still,'stopping keeps the entire identity DOM shape and navigation stable');
});
test('historical reports and ordinary identities never acquire name effects from avatar activity',()=>{
 for(const props of [
  {author:author('已归档专员','archived'),authorMotion:'working' as const},
  {identity:pilotIdentity,nameMotion:true},
  {identity:{name:'Lake'},motion:'working' as const,nameMotion:true},
  {author:author('连续回复','continued'),nameMotion:true,continued:true},
 ]){
  const html=renderToStaticMarkup(createElement(ReplyIdentity,props));
  assert.doesNotMatch(html,/live-text-motion|data-live-glow/);
 }
});
test('long specialist names animate the visible leading graphemes before ellipsis and keep their full readable name',()=>{
 const fullName='数据库👩🏽‍💻é核对专员'.repeat(5)+'尾部';
 const html=renderToStaticMarkup(createElement(ReplyIdentity,{identity:pilotIdentity,author:author(fullName,'long'),nameMotion:true,onSpecialist(){}}));
 const name=html.match(/<strong>([\s\S]*?)<\/strong>/)?.[1]??'';
 const graphemes=[...new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(fullName)];
 const animatedOffsets=[...name.matchAll(/class="live-text-motion-character" data-text-offset="(\d+)"/g)].map(match=>Number(match[1]));
 assert.deepEqual(animatedOffsets,graphemes.slice(0,24).map(part=>part.index),'a clipped long name must not reserve all motion for its invisible suffix');
 assert.equal(name.replace(/<[^>]*>/g,''),fullName,'selection and accessible text retain every character exactly once');
 assert.ok(name.includes(fullName.slice(graphemes[24]!.index)),'the rest of the name stays one static suffix');
 assert.ok(html.includes(`aria-label="查看${fullName}的任务记录"`));
});
test('equal reply text cannot erase a different specialist or turn its report into progress prose',()=>{
 const at='2026-11-02T12:00:00Z';
 const messages:Message[]=['Go 审查专员','前端执行专员'].map((name,index)=>({id:'report-'+index,sessionId:'pilot',role:'assistant',text:'same result',createdAt:at,author:author(name,String(index))}));
 const snapshot={session:{id:'pilot'},messages,actions:[],specialists:[],evidence:[],resources:[]} as unknown as SessionSnapshot;
 const entries=orderedTranscript(snapshot,[{id:'pilot-copy',type:'text',status:'completed',at,content:'same result'}],0);
 assert.equal(entries.filter(entry=>entry.message?.author).length,2);
 for(const entry of entries.filter(entry=>entry.message?.author))assert.equal(isAssistantProse(entry),false);
});
