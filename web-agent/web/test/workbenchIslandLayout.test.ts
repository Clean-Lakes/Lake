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
 assert.equal(result.columns[2],220);
 assert.equal(result.columns[0],258);
});
test('closing either auxiliary pane restores the compact island width',()=>{
 assert.deepEqual(workbenchIslandLayout(330,240,0,960),{width:572,columns:[330,240,0]});
 assert.deepEqual(workbenchIslandLayout(330,0,0,960),{width:332,columns:[330,0,0]});
 assert.deepEqual(workbenchIslandLayout(330,0,220,960),{width:552,columns:[330,0,220]});
 assert.equal(workbenchIslandLayout(330,240,220).width,792);
});

test('narrow split conversations keep every active control inside the input width',()=>{
 const result=workbenchIslandLayout(440,140,250,335);
 assert.equal(result.width,335);
 assert.ok(result.columns.every(width=>width>0));
});
