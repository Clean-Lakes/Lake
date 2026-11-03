import {test} from 'node:test';
import assert from 'node:assert/strict';
import {prepareSessionEntrance} from '../src/sessionEntrance';
test('history is placed at the changing tail before reveal; switching cancels old reveal',()=>{
 let next=0,height=300,top=0,visible=false;
 const queue=new Map<number,FrameRequestCallback>();
 const frames={request:(fn:FrameRequestCallback)=>{queue.set(++next,fn);return next;},cancel:(id:number)=>{queue.delete(id);}};
 const frame=()=>{const calls=[...queue.values()];queue.clear();calls.forEach(fn=>fn(0));};
 const cancel=prepareSessionEntrance(()=>{top=height;},()=>{visible=true;},frames);
 assert.equal(top,300);assert.equal(visible,false);
 height=2000;frame();assert.equal(top,2000);assert.equal(visible,false);
 height=2200;frame();assert.equal(top,2200);assert.equal(visible,true);
 cancel();visible=false;
 const cancelNext=prepareSessionEntrance(()=>{},()=>{visible=true;},frames);
 frame();cancelNext();frame();assert.equal(visible,false);assert.equal(queue.size,0);
});
