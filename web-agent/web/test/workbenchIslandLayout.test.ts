import {test} from 'node:test';
import assert from 'node:assert/strict';
import {workbenchIslandLayout} from '../src/workbenchIslandLayout';

test('one shared island keeps both section boundaries aligned after a pane resize',()=>{
 for(const [conversation,inspector,terminal] of [[600,382,400],[480,502,400],[720,280,0],[580,0,400]]){
  const result=workbenchIslandLayout(conversation,inspector,terminal);
  assert.equal(1+result.columns[0],conversation);
  if(terminal)assert.equal(1+result.columns[0]+result.columns[1],conversation+inspector);
  assert.equal(result.columns.reduce((a,b)=>a+b,0)+2,result.width);
 }
});
