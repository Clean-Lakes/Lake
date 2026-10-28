import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {naturalMemoryApi,naturalMemoryPath,type NaturalPreview} from '../src/naturalMemoryApi';
import {NaturalMemoryFoundation} from '../src/NaturalMemoryFoundation';

test('natural memory foundation explains separate automation and reversible management without an enable control',()=>{
 const html=renderToStaticMarkup(React.createElement(NaturalMemoryFoundation,{projectId:'a',busy:false,run:async task=>{await task();}}));
 assert.match(html,/自然形成见上方自动记忆实验开关/);
 assert.match(html,/不会停用原偏好/);
 assert.doesNotMatch(html,/type="checkbox"|type="radio"/);
 assert.match(html,/记忆内容承接/);
});
test('carry retries retain idempotency identity and the exact reviewed token/revision',async()=>{
 const original=globalThis.fetch;
 const requests:{url:string;method?:string;key:string|null;body:string}[]=[];
 let attempt=0;
 globalThis.fetch=async(input,init)=>{
  requests.push({url:String(input),method:init?.method,key:new Headers(init?.headers).get('Idempotency-Key'),body:String(init?.body)});
  attempt++;
  return new Response(JSON.stringify(attempt===1?{error:'retry'}:{id:'old',revision:4,changeId:'c'}),{status:attempt===1?503:200,headers:{'Content-Type':'application/json'}});
 };
 try{
  const preview={id:'old',previewToken:'reviewed',linkRevision:3} as NaturalPreview;
  const base=naturalMemoryPath('project/a');
  await assert.rejects(naturalMemoryApi.carry(base,preview));
  await naturalMemoryApi.carry(base,preview);
  assert.equal(requests[0].key,requests[1].key);
  assert.ok(requests[0].key);
  assert.equal(requests[0].url,'/api/projects/project%2Fa/natural-memory/legacy/old/carry');
  assert.deepEqual(JSON.parse(requests[1].body),{expectedRevision:3,previewToken:'reviewed'});
  await naturalMemoryApi.undo(base,'c',4);
  assert.notEqual(requests[2].key,requests[1].key);
  assert.deepEqual(JSON.parse(requests[2].body),{expectedRevision:4});
 }finally{globalThis.fetch=original;}
});
test('read endpoints never send an idempotency key or trigger retired strategy endpoints',async()=>{
 const original=globalThis.fetch;
 const calls:string[]=[];
 globalThis.fetch=async(input,init)=>{
  calls.push(String(input));assert.equal(init?.method,'GET');assert.equal(new Headers(init?.headers).get('Idempotency-Key'),null);
  return new Response(JSON.stringify({items:[],nextCursor:'',total:0}),{status:200});
 };
 try{
  const base=naturalMemoryPath('');
  await naturalMemoryApi.settings(base);await naturalMemoryApi.projectEntries(base);await naturalMemoryApi.preferences(base);await naturalMemoryApi.changes(base);await naturalMemoryApi.legacy(base);
  assert.ok(calls.every(c=>c.startsWith('/api/natural-memory/')));
  assert.ok(calls.every(c=>!c.includes('/strategy/')));
 }finally{globalThis.fetch=original;}
});

test('natural settings PATCH and exact-version undo use separate scoped contracts',async()=>{
 const {naturalPreferenceApi}=await import('../src/naturalMemoryApi');const original=globalThis.fetch;
 const calls:{url:string;method:string;key:string|null;body:unknown}[]=[];
 globalThis.fetch=async(input,init)=>{calls.push({url:String(input),method:init?.method||'',key:new Headers(init?.headers).get('Idempotency-Key'),body:JSON.parse(String(init?.body))});return new Response(JSON.stringify({revision:3}),{status:200})};
 try{const base=naturalMemoryPath('project-a');await naturalPreferenceApi.settings(base,2,true);await naturalPreferenceApi.undo(base,'change-a',3);assert.equal(calls[0].method,'PATCH');assert.deepEqual(calls[0].body,{expectedRevision:2,autoEnabled:true});assert.deepEqual(calls[1].body,{expectedRevision:3});assert.ok(calls.every(c=>!!c.key&&!c.url.includes('/strategy/')))}finally{globalThis.fetch=original}
});
test('natural update notice is commit-driven and offers view and undo without review adoption',async()=>{
 const {NaturalMemoryNotice}=await import('../src/NaturalMemoryNotice');
 const empty=renderToStaticMarkup(React.createElement(NaturalMemoryNotice,{notices:[]}));assert.equal(empty,'');
 const html=renderToStaticMarkup(React.createElement(NaturalMemoryNotice,{notices:[{changeId:'c',scope:'project:a',entryId:'e',revision:1}]}));
 assert.match(html,/已更新项目偏好/);assert.match(html,/查看/);assert.match(html,/撤销/);assert.match(html,/实验/);assert.doesNotMatch(html,/审核|采用/);
});
test('natural settings describe opt-in scope, preserved content and staged recall',async()=>{
 const {NaturalMemoryPreferences}=await import('../src/NaturalMemoryPreferences');
 const html=renderToStaticMarkup(React.createElement(NaturalMemoryPreferences,{projectId:'a',busy:false,run:async task=>{await task()}}));assert.match(html,/自动记忆 · 实验/);assert.match(html,/不补扫历史/);assert.match(html,/跨项目偏好需/);assert.match(html,/尚未接入后续回答/);assert.match(html,/关闭停止新增/);
});
