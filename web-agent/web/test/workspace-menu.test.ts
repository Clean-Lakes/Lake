import {test} from 'node:test';
import assert from 'node:assert/strict';
import {workspaceMenuParent,workspaceMenuPosition} from '../src/workspaceMenu';

test('workspace pages return one level without opening another surface',()=>{
 assert.equal(workspaceMenuParent('create'),'projects');
 assert.equal(workspaceMenuParent('delete'),'manage');
 assert.equal(workspaceMenuParent('manage'),'projects');
 for(const view of ['projects','home'] as const)assert.equal(workspaceMenuParent(view),'home');
});
test('all workspace pages open next to the rail at the same height as the trigger',()=>{
 const anchor={top:124,railRight:44,sidebarRight:306},viewport={width:1512,height:800};
 const result=workspaceMenuPosition(anchor,viewport);
 assert.deepEqual(result,{left:52,top:124,width:246,maxHeight:432});
 assert.equal(workspaceMenuPosition({...anchor,sidebarRight:420},viewport).width,360);
 assert.equal(workspaceMenuPosition({...anchor,sidebarRight:200},viewport).width,220);
});
test('short and narrow viewports retain an accessible inset rather than overflowing',()=>{
 for(const width of [240,320,768])for(const height of [200,400,800]){
  const result=workspaceMenuPosition({railRight:44,top:height-60,sidebarRight:Math.min(width,280)},{width,height});
  assert.ok(result.left>=8);assert.ok(result.left+result.width<=width-8);
  assert.ok(result.top>=8);assert.ok(height-result.top-result.maxHeight>=8);
  assert.ok(result.maxHeight>0&&result.maxHeight<=432);
 }
});
test('the available height caps each page without forcing a fixed height',()=>{
 const anchor={railRight:61,top:300,sidebarRight:310},viewport={width:768,height:350};
 assert.deepEqual(workspaceMenuPosition(anchor,viewport),{left:69,top:122,width:233,maxHeight:220});
});
