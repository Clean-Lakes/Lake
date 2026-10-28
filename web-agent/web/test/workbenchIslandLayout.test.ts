import {test} from 'node:test';
import assert from 'node:assert/strict';
import {workbenchIslandLayout} from '../src/workbenchIslandLayout';

test('three-pane mode fills the workspace while keeping the terminal bubble compact',()=>{
 const result=workbenchIslandLayout(330,240,220,1400);
 assert.equal(result.width,1400);
 assert.deepEqual(result.columns,[330,848,220]);
});
test('all three control groups fit before the terminal pane',()=>{
 const result=workbenchIslandLayout(440,240,220,720);
 assert.equal(result.width,720);
 assert.equal(result.columns[1],240);
 assert.equal(result.columns[2],218);
 assert.equal(result.columns[0],260);
});
test('closed panes leave no empty segments',()=>{
 assert.equal(workbenchIslandLayout(330,240,0,1400).width,572);
 assert.equal(workbenchIslandLayout(330,0,0,1400).width,332);
 assert.equal(workbenchIslandLayout(330,0,220,1400).width,552);
 assert.equal(workbenchIslandLayout(330,240,220).width,792);
});
