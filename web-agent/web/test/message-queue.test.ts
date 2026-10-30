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

import {pendingUserSupplements,visibleQueuedMessages,completeQueueOrder} from "../src/messageQueue";
import {islandFixture} from "./fixtures/pilot-island-data";
test('admitted supplements enter the current conversation before model acknowledgement without starting a turn',()=>{
 const snapshot=islandFixture();snapshot.messages=[];
 const item=(id:string,root?:string)=>({id,text:id,resourceIds:[],images:[],files:[],createdAt:'2026-10-30T00:00:00Z',supplementRootTurnId:root});
 snapshot.messageQueue={paused:false,revision:4,lastError:'',items:[item('draft'),item('other','other-root'),item('sent',snapshot.ai!.rootTurnId)]};
 assert.deepEqual(pendingUserSupplements(snapshot).map(item=>item.id),['sent']);
 assert.equal(snapshot.messages.length,0,'receipt projection must not fabricate an applied user turn');
 snapshot.messages.push({id:'sent',sessionId:snapshot.session.id,role:'user',text:'sent',createdAt:'2026-10-30T00:00:00Z'});
 assert.deepEqual(pendingUserSupplements(snapshot),[],'canonical receipt must replace rather than duplicate the projected message');
 snapshot.messageQueue.items[2]!.supplementRootTurnId=undefined;
 snapshot.messages=[];
 assert.deepEqual(pendingUserSupplements(snapshot),[],'unapplied input released after stop returns to the draft queue');
});
test('visible draft sorting retains in-flight supplemental messages and recovery restores them',()=>{
 const item=(id:string,root?:string)=>({id,text:id,resourceIds:[],images:[],files:[],createdAt:'',supplementRootTurnId:root});
 const queue={paused:false,revision:5,lastError:'',items:[item('a'),item('sent','root'),item('b'),item('c')]};
 assert.deepEqual(visibleQueuedMessages(queue,'root').map(item=>item.id),['a','b','c']);
 assert.deepEqual(completeQueueOrder(queue,['c','a','b'],'root'),['c','sent','a','b']);
 assert.equal(visibleQueuedMessages(queue),queue.items,'other views retain the admitted queue state');
 queue.items[1]!.supplementRootTurnId=undefined;
 assert.deepEqual(visibleQueuedMessages(queue,'root').map(item=>item.id),['a','sent','b','c']);
});
