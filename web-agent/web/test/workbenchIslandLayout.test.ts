import {test} from 'node:test';
import assert from 'node:assert/strict';
import {workbenchIslandLayout} from '../src/workbenchIslandLayout';

test('the conversation and inspector island fits content without filling wide panes',()=>{
 const result=workbenchIslandLayout(330,240,1400);
 assert.equal(result.width,572);
 assert.deepEqual(result.columns,[330,240]);
});
test('the island stays within the workspace before the independent terminal',()=>{
 const result=workbenchIslandLayout(440,240,560);
 assert.equal(result.width,560);
 assert.equal(result.columns[1],240);
 assert.equal(result.columns[0],318);
});
test('a closed inspector leaves only the conversation segment',()=>{
 assert.equal(workbenchIslandLayout(330,0,1400).width,332);
});
