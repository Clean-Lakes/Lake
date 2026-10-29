import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {reduceMemoryView,memoryDraft,memoryJobUsage} from '../src/projectMemoryState';
import {ProjectMemoryDetail} from '../src/ProjectMemoryDetail';
import {MemoryAccessSummary} from '../src/MemoryAccessSummary';
import type {ProjectMemoryList,ProjectMemoryEntry} from '../../shared/contracts';

test('memory state rejects old search responses and cross-project results',()=>{
 const empty={projectId:'A',sequence:1,list:null,error:''};
 const a={items:[{key:'A-secret'}],settings:{},total:1,projectRevision:1} as ProjectMemoryList;
 const requested=reduceMemoryView(empty,{type:'request',projectId:'B',sequence:2});
 assert.equal(requested.list,null);
 assert.equal(reduceMemoryView(requested,{type:'loaded',projectId:'A',sequence:1,list:a}),requested);
 const newer=reduceMemoryView(requested,{type:'request',projectId:'B',sequence:3});
 assert.equal(reduceMemoryView(newer,{type:'failed',projectId:'B',sequence:2,error:'stale'}),newer);
});
test('unclassified legacy memory never defaults to project scope and unknown cost is not zero',()=>{
 const draft=memoryDraft({key:'old-method',revision:1,reviewState:'needs_review'});
 assert.equal(draft.scopeKind,'resources');assert.deepEqual(draft.resourceIds,[]);
 assert.match(memoryJobUsage({dispatchCount:2,unknownAttempts:1,knownTokens:70} as Parameters<typeof memoryJobUsage>[0]),/未知/);
});
test('forgotten memories start with new content and explicit restoration',()=>{
 const draft=memoryDraft({key:'forgotten',revision:3,deletedAt:'2026-10-23T00:00:00Z'});
 assert.equal(draft.body,'');assert.equal(draft.restoreDeleted,true);assert.equal(draft.revision,3);
});
test('detail distinguishes observation from edits and uses shared selects',()=>{
 const entry={key:'service-port',type:'project',description:'服务端口',body:'该版本曾使用 8080。',revision:2,knowledgeKind:'configuration',scopeKind:'resources',resourceIds:['node-a'],factKey:'service.port',observedAt:'2026-10-22T08:00:00Z',updatedAt:'2026-10-23T08:00:00Z',validUntil:'2026-10-23T08:00:00Z',eligibility:'expired',verification:'observed',sources:[{sourceId:'source-1',kind:'evidence',observedAt:'2026-10-22T08:00:00Z'}]} as ProjectMemoryEntry;
 const html=renderToStaticMarkup(createElement(ProjectMemoryDetail,{draft:memoryDraft(entry),entry,resources:[],busy:false,onChange:()=>{},onSave:()=>{},onForget:()=>{},onBack:()=>{},onSource:()=>{}}));
 assert.match(html,/已有观测/);assert.match(html,/观测时间/);assert.match(html,/内容更新/);assert.match(html,/已过期/);assert.match(html,/不会刷新/);assert.match(html,/查看来源/);assert.match(html,/app-select/);
});
test('access summary never equates indexing with reading or adoption',()=>{
 const html=renderToStaticMarkup(createElement(MemoryAccessSummary,{entries:[{key:'rule',revision:1,kind:'index',at:'2026-10-23T00:00:00Z'},{key:'history',revision:2,kind:'read',at:'2026-10-23T00:00:00Z',historical:true}],onOpen:()=>{}}));
 assert.match(html,/索引 1 条 \/ 已读取 1 条/);assert.match(html,/仅索引/);assert.match(html,/历史资料/);assert.doesNotMatch(html,/已采纳|已验证/);
});
test('reading several pages of one revision counts as one memory',()=>{
 const html=renderToStaticMarkup(createElement(MemoryAccessSummary,{entries:[0,10].map(offsetLine=>({key:'large-method',revision:2,kind:'read' as const,offsetLine,at:'2026-10-23T00:00:00Z'}))}));
 assert.match(html,/已读取 1 条/);assert.doesNotMatch(html,/已读取 2 条/);
});
test('preference preparation stays distinct from actual reads and compliance',()=>{
 const html=renderToStaticMarkup(createElement(MemoryAccessSummary,{entries:[{key:'preference-a',revision:2,kind:'prepared',category:'preference',scope:'project',at:'2026-10-29T00:00:00Z'}]}));
 assert.match(html,/准备 1 条/);assert.match(html,/已读取 0 条/);assert.match(html,/项目偏好/);assert.match(html,/遵从未知/);assert.doesNotMatch(html,/已遵从|已采纳|已验证/);
});
