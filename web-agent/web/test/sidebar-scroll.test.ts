import assert from 'node:assert/strict';
import test from 'node:test';
import {sidebarScrollFromThumb,sidebarScrollGeometry} from '../src/sidebarScroll';

test('thumb length follows the visible content fraction with accurate first and last positions',()=>{
 for(const content of [801,1600,10000]){
  const first=sidebarScrollGeometry(800,content,0);
  const last=sidebarScrollGeometry(800,content,content-800);
  assert.equal(first.thumb,Math.max(28,724*800/content));
  assert.equal(first.top,0);
  assert.equal(last.top,last.travel);
  assert.equal(last.top+last.thumb,724);
  assert.equal(sidebarScrollFromThumb(first.travel,first.travel,first.range),first.range);
 }
 assert.ok(sidebarScrollGeometry(800,801,0).thumb>700,'near-fitting content must not jump with an artificially short thumb');
});
test('middle dragging maps back to the true scroll range and clamps overscroll',()=>{
 const middle=sidebarScrollGeometry(600,2600,1000);
 assert.equal(sidebarScrollFromThumb(middle.top,middle.travel,middle.range),1000);
 assert.equal(sidebarScrollFromThumb(-30,middle.travel,middle.range),0);
 assert.equal(sidebarScrollFromThumb(middle.travel+30,middle.travel,middle.range),2000);
});
test('no overflow and tiny viewports cannot produce out-of-track thumbs or NaN',()=>{
 assert.equal(sidebarScrollGeometry(800,400,0).thumb,0);
 assert.deepEqual(sidebarScrollGeometry(0,0,0),{range:0,thumb:0,travel:0,top:0});
 const small=sidebarScrollGeometry(90,1000,1000);
 assert.ok(small.top+small.thumb<=14);
 assert.equal(sidebarScrollFromThumb(10,0,10),0);
});
