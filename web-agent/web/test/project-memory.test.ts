import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ProjectMemoryGate} from '../src/ProjectMemoryGate';
import {MemoryAccessSummary} from '../src/MemoryAccessSummary';

// An editable child must not mount for retired, unknown or unqualified formats.
test('memory gate mounts the current editor only for a qualified V1 response',()=>{
 const current=()=>createElement('button',null,'current-editor');
 for(const version of [null,0,2,3,-1,NaN]){
  const html=renderToStaticMarkup(createElement(ProjectMemoryGate,{version,onClose:()=>{},children:createElement(current)}));
  assert.doesNotMatch(html,/current-editor/);assert.match(html,/role="dialog"/);assert.match(html,/关闭/);
 }
 const html=renderToStaticMarkup(createElement(ProjectMemoryGate,{version:1,onClose:()=>{},children:createElement(current)}));
 assert.match(html,/current-editor/);
 const failed=renderToStaticMarkup(createElement(ProjectMemoryGate,{version:1,error:'读取失败',onClose:()=>{},children:createElement(current)}));
 assert.doesNotMatch(failed,/current-editor/);assert.match(failed,/读取失败/);
});
test('retired memory has a closed view without editing or adoption controls',()=>{
 const html=renderToStaticMarkup(createElement(ProjectMemoryGate,{version:2,onClose:()=>{},children:createElement('button',null,'保存')}));
 assert.match(html,/已停用/);assert.match(html,/历史记录仍保留/);
 assert.equal((html.match(/<button/g)||[]).length,1);assert.doesNotMatch(html,/保存|审核|采用|重试/);
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
