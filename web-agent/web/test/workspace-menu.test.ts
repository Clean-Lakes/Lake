import {test} from 'node:test';
import assert from 'node:assert/strict';
import {workspaceMenuParent,workspaceMenuPosition} from '../src/workspaceMenu';

test('workspace pages return one level without opening another surface',()=>{
 assert.equal(workspaceMenuParent('create'),'projects');
 assert.equal(workspaceMenuParent('delete'),'manage');
 assert.equal(workspaceMenuParent('manage'),'projects');
 for(const view of ['projects','home'] as const)assert.equal(workspaceMenuParent(view),'home');
});
test('all workspace pages use the footer width and stable bottom anchor',()=>{
 const anchor={left:13,top:700,width:254},viewport={width:1512,height:800};
 const result=workspaceMenuPosition(anchor,viewport);
 assert.deepEqual(result,{left:13,bottom:108,width:254,maxHeight:432});
 assert.equal(viewport.height-result.bottom,anchor.top-8);
 for(const width of [174,254,394])assert.equal(workspaceMenuPosition({...anchor,width},viewport).width,width);
});
test('short and narrow viewports retain an accessible inset rather than overflowing',()=>{
 for(const width of [240,320,768])for(const height of [200,400,800]){
  const result=workspaceMenuPosition({left:width-100,top:height-60,width:300},{width,height});
  assert.ok(result.left>=8);assert.ok(result.left+result.width<=width-8);
  assert.ok(result.bottom>=8);assert.ok(height-result.bottom-result.maxHeight>=8);
  assert.ok(result.maxHeight>0&&result.maxHeight<=432);
 }
});
test('the available height caps each page without forcing a fixed height',()=>{
 const anchor={left:13,top:300,width:254},viewport={width:768,height:350};
 assert.deepEqual(workspaceMenuPosition(anchor,viewport),{left:13,bottom:58,width:254,maxHeight:284});
});
