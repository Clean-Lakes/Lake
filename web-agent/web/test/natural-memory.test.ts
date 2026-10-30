import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {naturalMemoryPath} from '../src/naturalMemoryApi';

test('memory settings expose only natural memory and project entries, without legacy management',async()=>{
 const {MemorySettings}=await import('../src/MemorySettings');
 const html=renderToStaticMarkup(React.createElement(MemorySettings,{projectId:'a',onBusyChange:()=>{},onProjectMemory:()=>{}}));
 assert.match(html,/记忆开关/);assert.match(html,/已保存的偏好/);assert.match(html,/查看当前项目的事实与经验/);
 assert.doesNotMatch(html,/历史资产与兼容管理|旧偏好承接|会话应用已采用资产|历史对照实验|历史候选与来源|人工资产继续/);
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
test('memory rules are available on demand after the controls and saved preferences',async()=>{
 const {NaturalMemoryPreferences}=await import('../src/NaturalMemoryPreferences');
 const html=renderToStaticMarkup(React.createElement(NaturalMemoryPreferences,{projectId:'a',busy:false,run:async task=>{await task()}}));
 assert.match(html,/自动积累偏好/);assert.match(html,/回答时使用偏好/);assert.match(html,/已保存的偏好/);
 const rules=html.indexOf('<summary>记忆如何工作</summary>');assert.ok(rules>html.indexOf('已保存的偏好'));assert.ok(html.indexOf('当前明确要求优先')>rules);assert.match(html,/各自默认关闭/);assert.doesNotMatch(html,/后台增量：|遵从未知|原项目事实、历史经验和人工资产/);
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

test('the two memory controls preserve independent persisted choices and loading disables writes',async()=>{
 const {MemoryPreferenceControls}=await import('../src/NaturalMemoryPreferences');
 for(const [autoEnabled,useEnabled] of [[false,true],[true,false],[false,false]]){
  const settings={scope:{kind:'user'},revision:4,autoEnabled,automaticReady:true,recallSettings:{revision:7,useEnabled},projectMemorySettings:null} as const;
  const html=renderToStaticMarkup(React.createElement(MemoryPreferenceControls,{settings,busy:false,onCapture:()=>{},onUse:()=>{}}));
  const inputs=html.match(/<input[^>]+>/g)!;assert.equal(inputs.length,2);assert.equal(inputs[0]!.includes('checked=""'),autoEnabled);assert.equal(inputs[1]!.includes('checked=""'),useEnabled);assert.ok(inputs.every(input=>!input.includes('disabled=""')));
 }
 const loading=renderToStaticMarkup(React.createElement(MemoryPreferenceControls,{settings:null,busy:false,onCapture:()=>{},onUse:()=>{}}));assert.equal((loading.match(/disabled=""/g)||[]).length,2);
});

test('saved preference content is plain text with version and source inside optional details',async()=>{
 const {MemoryPreferenceItem}=await import('../src/NaturalMemoryPreferences');
 const value={id:'private-internal-identifier',topic:'style',revision:12,contentRevision:12,body:'先给结论，再列依据。',state:'active',scope:'project:p',source:{private:false,available:true},parentRevision:11};
 const html=renderToStaticMarkup(React.createElement(MemoryPreferenceItem,{value,busy:false,onForget:()=>{}}));
 assert.match(html,/先给结论，再列依据。/);assert.doesNotMatch(html,/<pre|private-internal-identifier|确认遗忘偏好/);assert.ok(html.indexOf('版本 12')>html.indexOf('<summary>来源与版本</summary>'));assert.match(html,/>遗忘<\/button>/);
});

test('private source identities stay hidden in both normal and expanded change markup',async()=>{
 const {NaturalPreferenceChangeView}=await import('../src/NaturalMemoryPreferences');
 const after={id:'p',topic:'style',revision:2,contentRevision:2,body:'先给结论。',state:'active',scope:'user',source:{private:true,available:true,sessionId:'PRIVATE-SESSION',messageId:'PRIVATE-MESSAGE'},parentRevision:1};
 const html=renderToStaticMarkup(React.createElement(NaturalPreferenceChangeView,{value:{id:'c',entryId:'p',beforeRevision:1,afterRevision:2,kind:'replace',createdAt:'',undoneBy:'',after}}));
 assert.match(html,/修改后/);assert.match(html,/来源详情已隐藏/);assert.doesNotMatch(html,/PRIVATE-SESSION|PRIVATE-MESSAGE/);
});

test('background counts live in a closed status disclosure and deferred records are not called complete',async()=>{
 const {MemoryConsolidationDetails}=await import('../src/NaturalMemoryPreferences');
 const html=renderToStaticMarkup(React.createElement(MemoryConsolidationDetails,{value:{captured:0,processed:2,deferred:1,withdrawn:1,conflicts:0}}));
 assert.match(html,/<details[^>]*><summary>整理状态<\/summary>/);assert.doesNotMatch(html,/<details[^>]* open/);assert.match(html,/暂缓的记录尚未整理完成/);assert.match(html,/不影响正常对话/);
});
