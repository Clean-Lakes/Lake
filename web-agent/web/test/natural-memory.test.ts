import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {naturalMemoryApi,naturalMemoryPath,type NaturalPreview} from '../src/naturalMemoryApi';
import {NaturalMemoryFoundation} from '../src/NaturalMemoryFoundation';

test('natural memory foundation explains separate automation and reversible management without an enable control',()=>{
 const html=renderToStaticMarkup(React.createElement(NaturalMemoryFoundation,{projectId:'a',busy:false,run:async task=>{await task();}}));
 assert.match(html,/自然形成与空闲整理见上方自动记忆开关/);
 assert.match(html,/不会停用原偏好/);
 assert.doesNotMatch(html,/type="checkbox"|type="radio"/);
 assert.match(html,/旧偏好承接/);
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
test('natural settings describe opt-in scope, preserved content and independent scoped recall',async()=>{
 const {NaturalMemoryPreferences}=await import('../src/NaturalMemoryPreferences');
 const html=renderToStaticMarkup(React.createElement(NaturalMemoryPreferences,{projectId:'a',busy:false,run:async task=>{await task()}}));assert.match(html,/自动记忆 · 实验/);assert.match(html,/不补扫历史/);assert.match(html,/跨项目偏好需/);assert.match(html,/使用默认关闭/);assert.match(html,/关闭积累仍可使用/);assert.match(html,/当前明确要求优先/);assert.match(html,/专员与工作流不继承/);assert.doesNotMatch(html,/尚未接入后续回答/);
});

test('one persisted batch produces one notice with scoped optional per-item controls',async()=>{
 const {NaturalMemoryNotice}=await import('../src/NaturalMemoryNotice');
 const html=renderToStaticMarkup(React.createElement(NaturalMemoryNotice,{notices:[{changeId:'a',scope:'project:p',entryId:'x',revision:1,batchId:'batch'},{changeId:'b',scope:'user',entryId:'y',revision:1,batchId:'batch'}]}));
 assert.equal((html.match(/已更新/g)||[]).length,1);assert.match(html,/2 项/);assert.match(html,/查看/);assert.match(html,/撤销/);assert.doesNotMatch(html,/审核|采用/);
});
test('consolidation status and conflicts preserve scoped reads and CAS rejection',async()=>{
 const {naturalConsolidationApi}=await import('../src/naturalMemoryApi');const original=globalThis.fetch;const calls:{url:string;method:string;key:string|null;body:unknown}[]=[];
 globalThis.fetch=async(input,init)=>{calls.push({url:String(input),method:init?.method||'',key:new Headers(init?.headers).get('Idempotency-Key'),body:init?.body?JSON.parse(String(init.body)):null});return new Response(JSON.stringify({items:[],nextCursor:'',status:'rejected'}),{status:200})};
 try{const base=naturalMemoryPath('project/a');await naturalConsolidationApi.status(base);await naturalConsolidationApi.conflicts(base,'cursor');await naturalConsolidationApi.reject(base,'conflict',4);assert.equal(calls[0].key,null);assert.equal(calls[1].method,'GET');assert.match(calls[1].url,/project%2Fa/);assert.equal(calls[2].method,'POST');assert.ok(calls[2].key);assert.deepEqual(calls[2].body,{expectedRevision:4});assert.ok(calls.every(c=>!c.url.includes('/strategy/')))}finally{globalThis.fetch=original}
});

test('recall toggle uses its own revision and endpoint without changing capture consent',async()=>{
 const {naturalPreferenceApi}=await import('../src/naturalMemoryApi');const original=globalThis.fetch;
 let received:{url:string;method:string;body:unknown;key:string|null}|undefined;
 globalThis.fetch=async(input,init)=>{received={url:String(input),method:init?.method||'',body:JSON.parse(String(init?.body)),key:new Headers(init?.headers).get('Idempotency-Key')};return new Response(JSON.stringify({revision:3,useEnabled:false}),{status:200})};
 try{await naturalPreferenceApi.recallSettings(naturalMemoryPath('project/a'),2,false);assert.equal(received?.method,'PATCH');assert.match(received!.url,/project%2Fa\/natural-memory\/recall-settings$/);assert.deepEqual(received?.body,{expectedRevision:2,useEnabled:false});assert.ok(received?.key)}finally{globalThis.fetch=original}
});
