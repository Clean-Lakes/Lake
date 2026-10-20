import assert from "node:assert/strict";
import test from "node:test";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import type {ReplyTiming,SessionSnapshot} from "../../shared/contracts";
import {replyDurationText,timingForTurn} from "../src/replyDurationState";
import {AITranscript} from "../src/AIPanel";
import {ReplyDuration} from "../src/ReplyDuration";

const start="2026-10-12T03:00:00Z";
const timing:ReplyTiming={messageId:"u",startedAt:start,finishedAt:"2026-10-12T03:01:13Z",status:"completed"};
test("completed duration stays frozen and quick answers show a meaningful duration",()=>{
 assert.equal(replyDurationText(timing,Date.parse(start)+9_000_000),"1分钟 13秒 · 已完成");
 assert.equal(replyDurationText({...timing,finishedAt:start},Date.now()),"不到1秒 · 已完成");
 assert.equal(replyDurationText({...timing,status:"running",finishedAt:""},Date.parse(start)+19000),"19秒 · 正在思考…");
 assert.equal(replyDurationText({...timing,status:"running"},Date.parse(start)+19000,true),"19秒 · 等待确认");
});
test("cancelled and failed turns are identified; unknown endpoints do not fabricate time",()=>{
 assert.equal(replyDurationText({...timing,status:"cancelled"},Date.now()),"1分钟 13秒 · 已停止");
 assert.equal(replyDurationText({...timing,status:"failed"},Date.now()),"1分钟 13秒 · 未完成");
 assert.equal(replyDurationText({...timing,status:"interrupted",finishedAt:""},Date.now()),undefined);
 assert.equal(replyDurationText({...timing,finishedAt:""},Date.now()),undefined);
 assert.equal(replyDurationText({...timing,startedAt:"invalid"},Date.now()),undefined);
 assert.equal(replyDurationText({...timing,finishedAt:"2026-10-12T02:00:00Z"},Date.now()),undefined);
});
test("each footer stays with its own user turn and multi-Agent replies keep one timer",()=>{
 const snapshot={session:{id:"s"},messages:[{id:"u",role:"user",text:"你好",createdAt:start},{id:"v",role:"user",text:"谢谢",createdAt:"2026-10-12T03:02:00Z"}],resources:[],actions:[],specialists:[],evidence:[],replyTimings:[timing,{messageId:"v",startedAt:"2026-10-12T03:02:00Z",finishedAt:"2026-10-12T03:02:04Z",status:"completed"}],ai:{session:"s",status:"completed",startedAt:start,turnStartedAt:"2026-10-12T03:02:00Z",turnFinishedAt:"2026-10-12T03:02:04Z",cardsOffset:0,cards:[{id:"reply1",type:"message",content:"你好。",status:"completed",at:"2026-10-12T03:00:10Z"},{id:"reply2",type:"message",content:"不客气。",status:"completed",at:"2026-10-12T03:02:01Z"}],agentRuns:[{id:"run",sessionId:"s",role:"host",task:"检查",status:"completed",resourceIds:[],createdAt:"2026-10-12T03:00:01Z"}]}} as SessionSnapshot;
 assert.equal(timingForTurn([{id:"u",at:start,message:snapshot.messages[0]}],snapshot),timing);
 const html=renderToStaticMarkup(createElement(AITranscript,{snapshot}));
 assert.equal((html.match(/aria-label="回答耗时"/g)||[]).length,2);
 assert.ok(html.includes("1分钟 13秒"));assert.ok(html.includes("4秒"));assert.ok(!html.includes("已处理"));
 const legacy={...snapshot,replyTimings:undefined};
 assert.equal(timingForTurn([{id:"u",at:start,message:snapshot.messages[0]}],legacy),undefined);
 assert.equal(timingForTurn([{id:"v",at:snapshot.messages[1]!.createdAt,message:snapshot.messages[1]}],legacy)?.finishedAt,snapshot.ai!.turnFinishedAt);
});

test("waiting for first model data already has visible motion, independent of idle engine state",()=>{
 const snapshot={session:{id:"s"},messages:[{id:"u",role:"user",text:"你能看懂图片吗",createdAt:start}],resources:[],actions:[],replyTimings:[{...timing,status:"running",finishedAt:""}],ai:{session:"s",status:"idle",cards:[],cardsOffset:0}} as SessionSnapshot;
 const html=renderToStaticMarkup(createElement(AITranscript,{snapshot}));
 assert.ok(html.includes("reply-duration-spinner") && html.includes("正在思考…"));
 const completed=renderToStaticMarkup(createElement(AITranscript,{snapshot:{...snapshot,replyTimings:[timing]}}));
 assert.ok(!completed.includes("reply-duration-spinner") && completed.includes("1分钟 13秒")&&completed.includes("reply-duration-clock"));
 assert.ok(!completed.includes("回复结束")&&!completed.includes("turn-status-mark"),"finished timing uses a static clock without a repeated completion label");
});

test("quiet completion never conceals uncertain outcomes or invents a duration",()=>{
 const render=(props:Parameters<typeof ReplyDuration>[0])=>renderToStaticMarkup(createElement(ReplyDuration,props));
 assert.equal(render({view:{status:'completed',cards:[]} as never}),'',"missing timing does not become a made-up elapsed caption");
 const uncertain=render({timing,cards:[{id:'op',at:start,type:'operation',status:'unknown'}]});
 assert.ok(uncertain.includes('1分钟 13秒')&&uncertain.includes('reply-duration-clock')&&uncertain.includes('执行结果待核查'));
 for(const [status,label] of [['cancelled','已停止'],['failed','未完成'],['interrupted','记录已中断']] as const){
  assert.ok(render({timing:{...timing,status}}).includes(label));
 }
});
