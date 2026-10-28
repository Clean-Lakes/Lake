import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {naturalMemoryApi,naturalMemoryPath,type NaturalPreview} from '../src/naturalMemoryApi';
import {NaturalMemoryFoundation} from '../src/NaturalMemoryFoundation';

test('natural memory foundation explains unavailable automation and reversible management without an enable control',()=>{
 const html=renderToStaticMarkup(React.createElement(NaturalMemoryFoundation,{projectId:'a',busy:false,run:async task=>{await task();}}));
 assert.match(html,/自然形成与自动整理尚未开放/);
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
