import assert from 'node:assert/strict';
import test from 'node:test';
import {approvalPresentation} from '../src/approvalPresentation';
import type {AIView} from '../../shared/contracts';
type Approval=NonNullable<AIView['pending']>;
test('protected nested shell approval never claims a delete that was not identified',()=>{
 const pending={kind:'delete',risk:'dangerous',call:{name:'shell',arguments:JSON.stringify({command:'for p in 22 3306; do timeout 3 bash -c "echo > /dev/tcp/127.0.0.1/$p"; done'})},confirmation:'执行 test host'} as Approval;
 const copy=approvalPresentation(pending);
 assert.equal(copy.title,'命令需要额外确认');assert.equal(copy.note.includes('删除'),false);
 // Presentation must not modify the required confirmation or turn it into permission.
 assert.equal(pending.kind,'delete');assert.equal(pending.confirmation,'执行 test host');
 assert.equal(approvalPresentation({...pending,call:{...pending.call,name:'delete'}}).title,'删除操作需要确认');
});
test('file write and target approvals retain their actual operation labels',()=>{
 assert.equal(approvalPresentation({kind:'file_write',risk:'write',call:{name:'write'}} as Approval).title,'授权修改文件');
 assert.equal(approvalPresentation({kind:'resource_select',risk:'readonly',call:{name:'read'}} as Approval).title,'确认本次操作的目标资源');
});

test('attachment file-write confirmation explains the shared write permission',()=>{
 const fileWrite={kind:'file_write',risk:'write',call:{name:'stage_attachment'}} as Approval;
 assert.ok(approvalPresentation(fileWrite).note.includes('上传附件使用“静默修改文件”权限'));
 assert.ok(approvalPresentation(fileWrite).note.includes('当前未开启'));
 assert.ok(!approvalPresentation({...fileWrite,kind:'resource_select'}).note.includes('当前未开启'),'target selection must not claim file-write permission is off');
});
