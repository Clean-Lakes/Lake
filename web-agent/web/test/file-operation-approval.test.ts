import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {AIApproval,AIView} from '../../shared/contracts';
import {AIPending} from '../src/AIPanel';
import {fileApprovalInfo} from '../src/FileOperationApproval';
const pending:AIApproval={id:'file-approval',kind:'file_write',risk:'write',target:'Local machine',resourceId:'private-resource-id',fingerprint:'fingerprint',call:{id:'file-call',name:'write',arguments:JSON.stringify({path:'/Users/demo/Desktop/迁移方案.md',runtime:'local',asset_ref:'private-asset',content:'# 迁移方案\n\n## 执行步骤\n\n1. 检查\n2. 验证'})},preview:{before:'# 旧方案\n',after:'# 迁移方案\n\n## 执行步骤\n\n1. 检查\n2. 验证'}};
const render=(patch:Partial<AIApproval>={},extra={})=>renderToStaticMarkup(createElement(AIPending,{session:'fixture',view:{pending:{...pending,...patch}} as AIView,refresh:async()=>{},...extra}));
test('file confirmation displays a readable document, exact target and path instead of a JSON wall',()=>{
 const html=render();
 for(const value of ['文件操作确认','迁移方案.md','Local machine','/Users/demo/Desktop/迁移方案.md','<h1>迁移方案</h1>','<h2>执行步骤</h2>','>允许写入</button>','>拒绝</button>','尚未执行'])assert.ok(html.includes(value),value);
 for(const value of ['class="ai-pending"','private-resource-id','private-asset','asset_ref','&quot;content&quot;','\\n\\n'])assert.ok(!html.includes(value),value);
 assert.ok(!html.includes('<details open'));assert.ok(html.includes('技术参数'));
 assert.deepEqual(fileApprovalInfo(pending)?.stats,{added:6,removed:1});
});
test('preview comes from the actual prepared result, including an empty file',()=>{
 const actual={...pending,preview:{before:'old',after:'prepared result'}};
 assert.equal(fileApprovalInfo(actual)?.content,'prepared result');
 assert.equal(fileApprovalInfo({...actual,preview:{before:'old',after:''}})?.content,'');
 assert.ok(render({preview:{before:'old',after:''}}).includes('（空文件）'));
 const unknown={...pending,preview:undefined,call:{...pending.call,name:'edit',arguments:JSON.stringify({path:'/tmp/config',old_string:'old',new_string:'new'})}};
 assert.equal(fileApprovalInfo(unknown)?.content,undefined,'a patch is not invented into a full file');
});
test('required target confirmation, dangerous state, child identity and queued count remain visible',()=>{
 const html=render({risk:'dangerous',confirmation:'执行 演示主机'},{runId:'child',agentName:'执行员'});
 assert.ok(html.includes('高风险'));assert.ok(html.includes('请输入'));assert.ok(/disabled=""[^>]*>允许写入/.test(html));
 assert.ok(html.includes('执行员'));assert.equal(pending.id,'file-approval');assert.equal(pending.call.id,'file-call');
 const queue=renderToStaticMarkup(createElement(AIPending,{session:'fixture',view:{pending,pendingApprovals:[pending,pending]} as AIView,refresh:async()=>{}}));
 assert.ok(queue.includes('2 项操作待确认'));
});
test('delete, read and append state exactly what will happen',()=>{
 const deletion=render({kind:'delete',call:{...pending.call,name:'delete'}});
 assert.ok(deletion.includes('将删除下方文件'));assert.ok(deletion.includes('>删除文件</button>'));assert.ok(deletion.includes('旧方案'));
 assert.ok(render({kind:'file_read',call:{...pending.call,name:'read'},preview:undefined}).includes('>允许读取</button>'));
 const append=render({call:{...pending.call,name:'append'},preview:undefined});assert.ok(append.includes('追加内容预览'));assert.ok(append.includes('>允许追加</button>'));
});
test('untrusted Markdown cannot embed HTML, images or active links in approval previews',()=>{
 const html=render({preview:{after:'<script>bad()</script>\n\n![private](https://invalid.example/track)\n\n[click](javascript:bad())'}});
 assert.ok(!html.includes('<script>'));assert.ok(!html.includes('<img'));assert.ok(!html.includes('href='));
 const escaped=render({call:{...pending.call,arguments:JSON.stringify({path:'/tmp/<script>bad</script>.txt',content:'text'})},preview:undefined});
 assert.ok(!escaped.includes('<script>'));assert.ok(escaped.includes('&lt;script&gt;'));
});
test('unrelated and malformed approvals retain their existing review path',()=>{
 assert.equal(fileApprovalInfo({...pending,kind:'resource_select'}),null);
 for(const arguments_ of ['null','[]','{}','invalid'])assert.equal(fileApprovalInfo({...pending,call:{...pending.call,arguments:arguments_}}),null);
 assert.ok(render({kind:'resource_select'}).includes('确认本次操作的目标资源'));
});
