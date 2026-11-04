import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {mergeChannelEntries,SpecialistTaskControls} from '../src/SpecialistChannel';
import type {SessionSnapshot,SpecialistChannelEntry} from '../../shared/contracts';
import {isCompactionFallbackEntry} from '../src/timeline';

test('channel pagination and retries use source identity rather than report body',()=>{
 const entry=(id:string,at:string,source='worker-a'):SpecialistChannelEntry=>({id,sourceSessionId:source,taskId:`task-${source}`,createdAt:at,message:{id,sessionId:source,role:'assistant',text:'相同正文',createdAt:at}});
 const newer=entry('a','2026-11-03T01:00:01Z'),older=entry('b','2026-11-03T01:00:00Z','worker-b');
 const updated={...newer,message:{...newer.message!,text:'流式更新'}};
 const result=mergeChannelEntries([newer],[older,updated]);
 assert.deepEqual(result.map(item=>item.id),['b','a']);
 assert.equal(result[0]?.sourceSessionId,'worker-b');assert.equal(result[1]?.message?.text,'流式更新');
 assert.equal(mergeChannelEntries(result,[older]).length,2);
});

test('persisted channel diagnostics are quiet without filtering human or assistant quotations',()=>{
 const text='历史上下文整理未完成，已保留原上下文继续本轮对话。';
 const base={id:'diagnostic',sourceSessionId:'worker-a',taskId:'task-a',createdAt:'2026-11-03T01:00:01Z'};
 const card={...base,card:{id:'fallback',type:'notice',status:'completed',content:text,at:base.createdAt}};
 const message=(role:'user'|'assistant'|'system'):SpecialistChannelEntry=>({...base,message:{id:'message',sessionId:base.sourceSessionId,role,text,createdAt:base.createdAt}});
 const entries=[card,message('system'),message('user'),message('assistant')];
 const before=JSON.stringify(entries);
 assert.deepEqual(entries.map(isCompactionFallbackEntry),[true,true,false,false]);
 assert.equal(entries.filter(entry=>!isCompactionFallbackEntry(entry)).length,2);
 assert.equal(JSON.stringify(entries),before,'raw channel history and source identities stay intact');
});

test('two waiting task controls expose both original questions and approvals without enabling a disconnected channel',()=>{
 const snapshot=(id:string):SessionSnapshot=>({session:{id,title:`Task ${id}`},messages:[],resources:[],ai:{question:{id:`question-${id}`,questions:[{id:'work_contract',title:`Confirm task ${id}`,options:[{label:`Only ${id}`}]}]},pending:{id:`approval-${id}`,kind:'resource_select',risk:'readonly',target:`Host ${id}`,fingerprint:`fingerprint-${id}`,needsTerminal:false,call:{id:`call-${id}`,name:'inspect_host',arguments:'{}'}}}} as unknown as SessionSnapshot);
 const html=renderToStaticMarkup(createElement('div',null,...['A','B'].map(id=>createElement(SpecialistTaskControls,{key:id,snapshot:snapshot(id),connected:true}))));
 for(const id of ['A','B']){
  assert.ok(html.includes(`Confirm task ${id}`));
  assert.ok(html.includes(`question-question-${id}-work_contract`));
  assert.ok(html.includes(`Host ${id}`));
 }
 assert.equal((html.match(/>提交并继续/g)??[]).length,2);
 assert.equal((html.match(/>使用此资源<\/button>/g)??[]).length,2);
 assert.match(renderToStaticMarkup(createElement(SpecialistTaskControls,{snapshot:snapshot('A'),connected:false})),/<fieldset[^>]*disabled=""/);
});
