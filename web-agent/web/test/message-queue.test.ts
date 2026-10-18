import assert from "node:assert/strict";
import test from "node:test";
import {reorderQueuedMessages} from "../src/messageQueue";

test("queue moves preserve every message and unaffected relative order",()=>{
 const ids=["a","b","c","d"];
 assert.deepEqual(reorderQueuedMessages(ids,"a",2),["b","c","a","d"]);
 assert.deepEqual(reorderQueuedMessages(ids,"d",0),["d","a","b","c"]);
 assert.deepEqual(ids,["a","b","c","d"]);
});
test("stale drag identifiers and boundary keyboard moves do not remove messages",()=>{
 const ids=["a","b","c"];
 for (const [id,position] of [["missing",0],["a",-1],["c",3],["b",.5]] as const) assert.equal(reorderQueuedMessages(ids,id,position),ids);
});

import {queueDropAt,queueDragScroll} from "../src/queueDrag";
const rows=[{id:'a',top:10,bottom:48},{id:'b',top:54,bottom:92},{id:'c',top:98,bottom:136}];
test('pointer sorting uses row midpoints without off-by-one downward moves',()=>{
 assert.equal(queueDropAt(rows,'a',60),null);
 const drop=queueDropAt(rows,'a',80)!;
 assert.deepEqual(drop,{position:1,id:'c',edge:'before'});
 assert.deepEqual(reorderQueuedMessages(['a','b','c'],'a',drop.position),['b','a','c']);
});
test('pointer sorting reaches both ends and ignores clicks within the source slot',()=>{
 assert.deepEqual(queueDropAt(rows,'c',0),{position:0,id:'a',edge:'before'});
 assert.deepEqual(queueDropAt(rows,'a',150),{position:2,id:'c',edge:'after'});
 assert.equal(queueDropAt(rows,'b',70),null);
 assert.equal(queueDropAt(rows,'missing',70),null);
 assert.equal(queueDropAt(rows,'a',NaN),null);
});
test('dragging scrolls only near the list edges and caps speed outside the viewport',()=>{
 assert.equal(queueDragScroll(80,0,160),0);
 assert.ok(queueDragScroll(10,0,160)<0);
 assert.ok(queueDragScroll(150,0,160)>0);
 assert.equal(queueDragScroll(-1000,0,160),-9);
 assert.equal(queueDragScroll(1000,0,160),9);
 assert.equal(queueDragScroll(0,0,0),0);
});
