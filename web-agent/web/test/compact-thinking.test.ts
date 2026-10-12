import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {AICard, AIView, SessionSnapshot} from "../../shared/contracts";
import {ThinkingTimeline} from "../src/ThinkingTimeline";
import {AIProgress} from "../src/AIProgress";
import {AITranscript} from "../src/AIPanel";

const start="2026-10-11T00:00:00Z";
const thought:AICard={id:"thought",type:"thinking",content:"VERY_VERBOSE_RAW_REASONING",status:"running",at:start};
const read:AICard={id:"read",type:"operation",title:"read",status:"running",at:start,data:{arguments:{path:"/tmp/example.log"},target:"Local machine"}};
test("live thinking defaults to a single short current-action line without raw thoughts or details",()=>{
  const html=renderToStaticMarkup(createElement(ThinkingTimeline,{cards:[thought,read],live:true}));
  assert.ok(html.includes('aria-expanded="false"'));assert.ok(html.includes("正在读取 example.log"));
  assert.ok(!html.includes(thought.content!));assert.ok(!html.includes("调用参数"));assert.ok(!html.includes("thinking-steps"));
});
test("finished history stays collapsed and records an operation count",()=>{
  const html=renderToStaticMarkup(createElement(ThinkingTimeline,{cards:[{...thought,status:"completed"},{...read,status:"completed"}],live:false}));
  assert.ok(html.includes("已处理 1 项操作"));assert.ok(!html.includes(thought.content!));
});
test("the compact timeline owns progress, without a duplicate activity or running timer",()=>{
  const view={session:"demo",status:"running",turnStartedAt:start,profile:"core",cards:[thought,read],cardsOffset:0} as AIView;
  assert.equal(renderToStaticMarkup(createElement(AIProgress,{view,cards:view.cards,latestUserAt:start,thinkingVisible:true})),"");
  const snapshot={session:{id:"demo"},messages:[{id:"user",role:"user",createdAt:start,text:"Read fixture"}],actions:[],ai:view} as SessionSnapshot;
  const html=renderToStaticMarkup(createElement(AITranscript,{snapshot}));
  assert.equal(html.split("正在读取 example.log").length-1,1);
  assert.ok(!html.includes("VERY_VERBOSE_RAW_REASONING"));
});

test("compaction limit failures display one Chinese message with history-preservation guidance",()=>{
 const error="context compaction: model output limit reached; incomplete response discarded";
 const snapshot={session:{id:"demo"},messages:[{id:"user",role:"user",createdAt:start,text:"cpu呢"},{id:"system-copy",role:"system",createdAt:start,text:error}],actions:[],ai:{session:"demo",status:"failed",startedAt:start,cards:[{id:"error-card",type:"error",content:error,status:"failed",at:start}],cardsOffset:0}} as SessionSnapshot;
 const html=renderToStaticMarkup(createElement(AITranscript,{snapshot}));
 assert.equal(html.split("上下文整理未完成").length-1,1);
 assert.ok(html.includes("历史记录已保留"));assert.ok(!html.includes("incomplete response discarded"));
});
