import assert from "node:assert/strict";
import test from "node:test";
import { compareTime, orderedTranscript, transcriptGroups } from "../src/timeline.ts";
import type { SessionSnapshot } from "../../shared/contracts.ts";

test("old pending approval stays before the next user turn and Go cards", () => {
 const snapshot = { messages: [
   {id:"user1",role:"user",createdAt:"2026-10-10T09:00:00.000Z"},
   {id:"reply1",role:"assistant",createdAt:"2026-10-10T09:00:01.000Z"},
   {id:"user2",role:"user",createdAt:"2026-10-10T09:00:04.000Z"},
 ], actions: [{id:"old",status:"pending",createdAt:"2026-10-10T09:00:02.000Z"}, {id:"bridge",status:"succeeded",createdAt:"2026-10-10T09:00:05.000Z"}], ai: {startedAt:"2026-10-10T09:00:04.001Z"} } as SessionSnapshot;
 const cards = [{id:"go",type:"message",content:"new reply",status:"completed",at:"2026-10-10T09:00:06.000Z"}];
 assert.deepEqual(orderedTranscript(snapshot,cards,0).map(e=>e.id),["user1","reply1","old","user2","go"]);
 // Changing old action status never moves it into a new round.
 snapshot.actions[0]!.status="rejected";
 assert.deepEqual(orderedTranscript(snapshot,cards,0).map(e=>e.id),["user1","reply1","old","user2","go"]);
});
test("millisecond and Go nanosecond timestamps share a chronological order",()=>{
 assert.ok(compareTime("2026-10-10T09:00:04.123Z","2026-10-10T09:00:04.123456789Z")<0);
 assert.equal(compareTime("2026-10-10T09:00:04.123000000Z","2026-10-10T09:00:04.123Z"),0);
});

test("thinking timelines hide compaction hints and preserve turn/reply boundaries", () => {
 const snapshot = {messages: [{id:"user1",role:"user",createdAt:"2026-10-11T09:00:00Z"},{id:"user2",role:"user",createdAt:"2026-10-11T09:00:06Z"}],actions:[],ai:{startedAt:"2026-10-11T09:00:00Z"}} as SessionSnapshot;
 const card = (id:string,type:string,second:number) => ({id,type,content:type==="compaction"?"上下文已压缩":"fixture",status:"completed",at:`2026-10-11T09:00:0${second}Z`});
 const entries=orderedTranscript(snapshot,[card("thought1","thinking",1),card("compact","compaction",2),card("tool1","operation",3),card("reply1","message",4),card("thought2","thinking",5),card("tool2","operation",7)],0);
 assert.ok(!entries.some(entry=>entry.card?.type==="compaction"));
 assert.deepEqual(transcriptGroups(entries).map(group=>group.map(entry=>entry.id)),[["user1"],["thought1","tool1"],["reply1"],["thought2"],["user2"],["tool2"]]);
});
test("native approvals keep their own place outside thinking timelines", () => {
 const entries=[{id:"thought",at:"",card:{id:"thought",type:"thinking",content:"fixture",status:"completed",at:""}},{id:"old-approval",at:"",action:{id:"old-approval"} as SessionSnapshot["actions"][number]},{id:"tool",at:"",card:{id:"tool",type:"operation",status:"completed",at:""}}];
 assert.deepEqual(transcriptGroups(entries).map(group=>group.map(entry=>entry.id)),[["thought"],["old-approval"],["tool"]]);
});

test("a fatal compaction error is shown once per turn even in old duplicate histories", () => {
 const error="context compaction: model output limit reached; incomplete response discarded";
 const snapshot={messages:[{id:"user",role:"user",text:"cpu呢",createdAt:"2026-10-12T09:00:00Z"},{id:"system-copy",role:"system",text:error,createdAt:"2026-10-12T09:00:03Z"},{id:"real-note",role:"system",text:"distinct warning",createdAt:"2026-10-12T09:00:04Z"}],actions:[],ai:{startedAt:"2026-10-12T09:00:00Z"}} as SessionSnapshot;
 const cards=[{id:"error-card",type:"error",content:error,status:"failed",at:"2026-10-12T09:00:02Z"}];
 assert.deepEqual(orderedTranscript(snapshot,cards,0).map(entry=>entry.id),["user","error-card","real-note"]);
});

test("native assistant scope questions survive after the Go engine has started",()=>{
 const snapshot={messages:[{id:"user1",role:"user",text:"再试试",createdAt:"2026-10-16T00:00:01Z"},{id:"scope1",role:"assistant",text:"请先用 @ 引用本次任务的目标资源，再开始 SRE 协作。",createdAt:"2026-10-16T00:00:02Z"},{id:"user2",role:"user",text:"?",createdAt:"2026-10-16T00:00:03Z"},{id:"scope2",role:"assistant",text:"请先用 @ 引用本次任务的目标资源，再开始 SRE 协作。",createdAt:"2026-10-16T00:00:04Z"}],actions:[],ai:{startedAt:"2026-10-15T00:00:00Z"}} as SessionSnapshot;
 assert.deepEqual(orderedTranscript(snapshot,[],0).map(e=>e.id),["user1","scope1","user2","scope2"]);
});
test("assistant mirrors deduplicate by actual content within their own turn",()=>{
 const at=(n:number)=>`2026-10-16T00:00:0${n}Z`;
 const snapshot={messages:[{id:"user1",role:"user",text:"one",createdAt:at(0)},{id:"mirror",role:"assistant",text:"same reply",createdAt:at(2)},{id:"notice",role:"assistant",text:"a separate notice",createdAt:at(3)},{id:"user2",role:"user",text:"two",createdAt:at(4)},{id:"native2",role:"assistant",text:"same reply",createdAt:at(5)}],actions:[],ai:{startedAt:at(0)}} as SessionSnapshot;
 const cards=[{id:"reply-card",type:"message",content:"same reply",status:"completed",at:at(1)}];
 assert.deepEqual(orderedTranscript(snapshot,cards,0).map(e=>e.id),["user1","reply-card","notice","user2","native2"]);
});
