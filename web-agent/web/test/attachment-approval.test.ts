import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {AIApproval,AIView,TextFileAttachment} from '../../shared/contracts';
import {AIPending} from '../src/AIPanel';
import {attachmentApprovalInfo} from '../src/AttachmentApproval';
const file:TextFileAttachment={sourceId:'file-private-source',name:'部署原件.zip',sizeBytes:12066};
const pending={id:'approval',kind:'file_write',risk:'write',target:'测试应用服务器',resourceId:'private-resource-id',fingerprint:'fingerprint',call:{id:'call',name:'stage_attachment',arguments:JSON.stringify({source_id:file.sourceId,asset_ref:'private-alias',runtime:'ssh',path:'/opt/releases/重命名的部署包.zip'})}} as AIApproval;
const render=(patch:Partial<AIApproval>={},extra={})=>renderToStaticMarkup(createElement(AIPending,{session:'test',view:{pending:{...pending,...patch}} as AIView,attachments:[file],refresh:async()=>{},...extra}));
test('upload approval shows the original file, destination and explicit upload action without tool jargon',()=>{
 const html=render();
 const primary=html.split('<details')[0]!;
 for(const text of ['部署原件.zip','11.8 KiB','测试应用服务器','/opt/releases/重命名的部署包.zip','同名文件不会被覆盖'])assert.ok(primary.includes(text),text);
 for(const text of ['stage_attachment','private-resource-id','private-alias','file-private-source','source_id','asset_ref'])assert.ok(!primary.includes(text),text);
 assert.ok(html.includes('>上传文件</button>'));assert.ok(html.includes('>取消</button>'));
 assert.ok(!html.includes('ai-pending"'));assert.ok(!html.includes('<details open'));
 assert.ok(html.includes('技术参数'));assert.ok(html.includes('file-private-source'),'exact parameters remain inspectable');
});
test('overwrite and typed target confirmation remain explicit and cannot be bypassed by the new UI',()=>{
 const html=render({confirmation:'执行 测试应用服务器',call:{...pending.call,arguments:JSON.stringify({...JSON.parse(pending.call.arguments),overwrite:true})}});
 assert.ok(html.includes('将覆盖原文件'));assert.ok(html.includes('disabled=""')&&html.includes('>覆盖并上传</button>'));
});
test('child approvals get the same readable layout and keep the original identity for decisions',()=>{
 const html=render({}, {runId:'child',agentName:'调查员'});
 assert.ok(html.includes('文件上传确认'));assert.ok(html.includes('部署原件.zip'));assert.ok(!html.includes('stage_attachment'));
 assert.equal(pending.id,'approval');assert.equal(pending.call.id,'call');
});
test('missing attachment metadata is honest, malformed parameters and other approval kinds retain the generic path',()=>{
 assert.equal(attachmentApprovalInfo(pending,[])?.file,undefined);
 assert.ok(render({}, {attachments:[]}).includes('所选附件'));
 assert.equal(attachmentApprovalInfo({...pending,call:{...pending.call,arguments:'null'}}),null);
 assert.equal(attachmentApprovalInfo({...pending,call:{...pending.call,arguments:'{}'}}),null);
 assert.ok(!render({kind:'resource_select'}).includes('aria-label="文件上传确认"'));
 const escaped=render({}, {attachments:[{...file,name:'<script>bad()</script>.zip'}]});assert.ok(!escaped.includes('<script>'));assert.ok(escaped.includes('&lt;script&gt;'));
});
