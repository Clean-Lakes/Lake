import {test} from 'node:test';
import assert from 'node:assert/strict';
import {workspaceMenuParent,workspaceMenuPosition} from '../src/workspaceMenu';

test('workspace pages return one level without opening another surface',()=>{
 assert.equal(workspaceMenuParent('create'),'projects');
 assert.equal(workspaceMenuParent('delete'),'manage');
 for(const view of ['projects','manage','home'] as const)assert.equal(workspaceMenuParent(view),'home');
});
test('all workspace pages use the footer width and stable bottom anchor',()=>{
 const anchor={left:13,top:700,width:254},viewport={width:1512,height:800};
 const result=workspaceMenuPosition(anchor,viewport);
 assert.deepEqual(result,{left:13,bottom:108,width:254,height:432});
 assert.equal(viewport.height-result.bottom,anchor.top-8);
 for(const width of [174,254,394])assert.equal(workspaceMenuPosition({...anchor,width},viewport).width,width);
});
test('short and narrow viewports retain an accessible inset rather than overflowing',()=>{
 for(const width of [240,320,768])for(const height of [200,400,800]){
  const result=workspaceMenuPosition({left:width-100,top:height-60,width:300},{width,height});
  assert.ok(result.left>=8);assert.ok(result.left+result.width<=width-8);
  assert.ok(result.bottom>=8);assert.ok(height-result.bottom-result.height>=8);
  assert.ok(result.height>0&&result.height<=432);
 }
});
test('home content determines the shared height without a reserved blank footer',()=>{
 const anchor={left:13,top:700,width:254},viewport={width:1512,height:800};
 const compact=workspaceMenuPosition(anchor,viewport,386);
 assert.equal(compact.height,386);
 assert.equal(compact.bottom,workspaceMenuPosition(anchor,viewport).bottom);
 assert.equal(workspaceMenuPosition(anchor,viewport,800).height,432);
});
