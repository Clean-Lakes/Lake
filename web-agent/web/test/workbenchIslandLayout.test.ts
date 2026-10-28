import {test} from 'node:test';
import assert from 'node:assert/strict';
import {workbenchIslandLayout} from '../src/workbenchIslandLayout';

test('three-pane mode follows the composer rail while keeping the terminal bubble compact',()=>{
 const result=workbenchIslandLayout(330,240,220,1400);
 assert.equal(result.width,1400);
 assert.deepEqual(result.columns,[330,848,220]);
});
test('all three control groups fit before the terminal pane',()=>{
 const result=workbenchIslandLayout(440,240,220,720);
 assert.equal(result.width,720);
 assert.equal(result.columns[1],240);
 assert.equal(result.columns[2],178);
 assert.equal(result.columns[0],300);
});
test('closing either auxiliary pane restores the compact island width',()=>{
 assert.deepEqual(workbenchIslandLayout(330,240,0,960),{width:572,columns:[330,240,0]});
 assert.deepEqual(workbenchIslandLayout(330,0,0,960),{width:332,columns:[330,0,0]});
 assert.deepEqual(workbenchIslandLayout(330,0,220,960),{width:552,columns:[330,0,220]});
 assert.equal(workbenchIslandLayout(330,240,220).width,792);
});

test('narrow split conversations keep every active control inside the input width',()=>{
 const result=workbenchIslandLayout(130,140,250,335);
 assert.equal(result.width,335);
 assert.ok(result.columns.every(width=>width>0));
});

test('a tight three-pane rail preserves readable conversation and compact side controls',()=>{
 const normal=workbenchIslandLayout(330,128,200,402);
 assert.deepEqual(normal.columns,[216,84,100]);
 const narrow=workbenchIslandLayout(130,140,250,335);
 assert.equal(narrow.width,335);
 assert.equal(narrow.columns[0],130);
 assert.ok(narrow.columns[1]!>=84);
 assert.ok(narrow.columns[2]!>=100);
});

test('status-only four-pane entry leaves readable tabs and terminal controls',()=>{
 assert.deepEqual(workbenchIslandLayout(130,128,200,320),{width:320,columns:[130,88,100]});
 assert.deepEqual(workbenchIslandLayout(130,128,200,335).columns,[130,103,100]);
 assert.equal(workbenchIslandLayout(130,128,200,720).columns[0],130);
});
