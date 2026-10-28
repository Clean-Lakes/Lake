import {test} from 'node:test';
import assert from 'node:assert/strict';
import {workbenchIslandLayout} from '../src/workbenchIslandLayout';

const conversation={left:328,width:320,inset:0};
const widths={conversationWidth:286,inspectorWidth:144,terminalWidth:300};
test('each island stays inside its own pane instead of competing for the composer rail',()=>{
 const result=workbenchIslandLayout({conversation,inspector:{left:696,width:240},terminal:{left:936,width:296},...widths});
 assert.deepEqual(result,{conversation:{left:328,width:286},inspector:{left:712,width:144},terminal:{left:952,width:264}});
 assert.ok(result.conversation.left+result.conversation.width<result.inspector!.left);
 assert.ok(result.inspector!.left+result.inspector!.width<result.terminal!.left);
 assert.ok(result.terminal!.left+result.terminal!.width<=1232-16);
});
test('closing either side island never expands or shortens the conversation island',()=>{
 const base=workbenchIslandLayout({conversation,...widths});
 for(const inspector of [undefined,{left:696,width:382}])for(const terminal of [undefined,{left:1078,width:400}]){
  const result=workbenchIslandLayout({conversation,inspector,terminal,...widths});
  assert.deepEqual(result.conversation,base.conversation);
  assert.equal(!!result.inspector,!!inspector);assert.equal(!!result.terminal,!!terminal);
 }
});
test('narrow panes clamp their own controls without borrowing a sibling pane',()=>{
 const result=workbenchIslandLayout({conversation:{left:328,width:210,inset:0},inspector:{left:538,width:170},terminal:{left:708,width:190},...widths});
 assert.equal(result.conversation.width,210);
 assert.equal(result.inspector!.width,138);assert.equal(result.terminal!.width,158);
});
