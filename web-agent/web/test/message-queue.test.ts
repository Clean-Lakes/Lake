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
