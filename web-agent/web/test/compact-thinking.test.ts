import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {AICard, AIView, SessionSnapshot} from "../../shared/contracts";
import {ThinkingTimeline} from "../src/ThinkingTimeline";
import {AITranscript} from "../src/AIPanel";
import {displayAiError} from "../src/aiErrors";
import {progressGlyph} from '../src/activity';

const start="2026-10-11T00:00:00Z";
const thought:AICard={id:"thought",type:"thinking",content:"VERY_VERBOSE_RAW_REASONING",status:"running",at:start};
const read:AICard={id:"read",type:"operation",title:"read",status:"running",at:start,data:{arguments:{path:"/tmp/example.log"},target:"Local machine"}};
test('malformed model calls explain that planning can continue with existing evidence',()=>{
 const message=displayAiError('invalid or duplicate model tool call: arguments must be a JSON object');
 assert.match(message,/本轮未完成/);assert.match(message,/已有调查结果和消息已保留/);assert.match(message,/原会话继续/);
 assert.doesNotMatch(message,/invalid or duplicate/);
});
test('progress icons follow tool identity without guessing from command or result text',()=>{
 assert.equal(progressGlyph({...read,title:'shell',content:'query_sql',data:{arguments:{command:'cat file'}}}),'lakeTerminal');
 assert.equal(progressGlyph({...read,title:'query_sql'}),'lakeDatabase');
 assert.equal(progressGlyph({...read,title:'list_workflows'}),'lakeWorkflow');
 assert.equal(progressGlyph({...read,title:'future_tool',content:'shell read_file'}),'lakeProcess');
 const html=renderToStaticMarkup(createElement(ThinkingTimeline,{cards:[{...read,title:'shell'},{...read,id:'later',status:'completed'}],live:true,resourceRow:true}));
 assert.ok(html.includes('data-glyph="lakeTerminal"'),'active tool matches summary even if later record completed');
 assert.equal((html.match(/thinking-process-icon/g)||[]).length,1,'group still has exactly one leading icon');
});
test('execution water stays scoped to a live running step, including stale historical cards',()=>{
 const render=(cards:AICard[],live:boolean,continuing=false)=>renderToStaticMarkup(createElement(ThinkingTimeline,{cards,live,continuing}));
 assert.ok(render([read],true).includes('execution-icon-water'));
 assert.ok(!render([read],false).includes('execution-icon-water'),'a retained running record must not animate in history');
 assert.ok(render([{...read,status:'completed'}],true,true).includes('execution-icon-water'),'the latest normal icon continues while the turn progresses');
 assert.ok(!render([{...read,status:'completed'}],true,false).includes('execution-icon-water'),'older returned tools remain static');
 assert.ok(!render([read,{...read,id:'approval',status:'pending'}],true).includes('execution-icon-water'),'approval blocks the group animation');
});
test("stalled model streams explain retained partial output and allow a follow-up",()=>{
 const text=displayAiError("model stream idle timeout; partial reply retained");
 assert.ok(text.includes("已停止等待")&&text.includes("已收到的回复和操作记录已保留")&&text.includes("继续发送"));
 assert.ok(displayAiError("context compaction: model stream idle timeout; partial reply retained").includes("历史记录已保留"));
});
test("execution deadlines explain timeout and uncertain command state without blaming context size",()=>{
 const text=displayAiError("context deadline exceeded");
 assert.ok(text.includes("等待超时")&&text.includes("操作记录已保留")&&text.includes("命令可能仍在运行"));
 assert.ok(!text.includes("上下文"));
 assert.equal(displayAiError("The log says context deadline exceeded"),"The log says context deadline exceeded");
});
test("compaction HTTP failures explain configuration or channel recovery without blaming context size",()=>{
 const missing=displayAiError("context compaction: model returned HTTP 404");
 assert.ok(missing.includes("API 格式")&&missing.includes("Base URL")&&missing.includes("历史记录已保留"));
 const unavailable=displayAiError("context compaction: model returned HTTP 503: No available accounts supporting model: fixture");
 assert.ok(unavailable.includes("模型渠道")&&unavailable.includes("可用账号")&&unavailable.includes("历史记录已保留"));
 assert.ok(!unavailable.includes("No available accounts"));
 assert.equal(displayAiError("An assistant explains HTTP 404 in prose"),"An assistant explains HTTP 404 in prose");
});
test("compaction timeout and cancellation preserve original-session recovery without claiming tool execution",()=>{
 const timeout=displayAiError("context compaction: Post endpoint: context deadline exceeded");
 assert.ok(timeout.includes("上下文整理超时")&&timeout.includes("历史消息和操作记录已保留")&&timeout.includes("原会话重试"));
 assert.ok(!timeout.includes("命令可能仍在运行"));
 assert.ok(displayAiError("context compaction: context canceled").includes("已停止整理上下文"));
});
test("tool-turn budget failure is localized with preserved-history guidance",()=>{
 const text=displayAiError("current tool turn exceeds context budget");
 assert.ok(text.includes("本轮上下文"));assert.ok(text.includes("操作记录已保留"));assert.ok(!text.includes("exceeds"));
});
test("live thinking defaults to a single short current-action line without raw thoughts or details",()=>{
  const html=renderToStaticMarkup(createElement(ThinkingTimeline,{cards:[thought,read],live:true}));
  assert.ok(html.includes('aria-expanded="false"'));assert.ok(html.includes("读取 example.log · Local machine"));
  assert.ok(!html.includes(thought.content!));assert.ok(!html.includes("调用参数"));assert.ok(!html.includes("thinking-steps"));
});
test("finished history stays collapsed and describes the actual operation",()=>{
  const html=renderToStaticMarkup(createElement(ThinkingTimeline,{cards:[{...thought,status:"completed"},{...read,status:"completed"}],live:false}));
  assert.ok(html.includes("读取 example.log · Local machine"));assert.ok(!html.includes(thought.content!));
});
test("live execution opens its resource row without duplicating the latest action caption",()=>{
  const view={session:"demo",status:"running",turnStartedAt:start,profile:"core",cards:[thought,read],cardsOffset:0} as AIView;
  const snapshot={session:{id:"demo"},messages:[{id:"user",role:"user",createdAt:start,text:"Read fixture"}],actions:[],ai:view} as SessionSnapshot;
  const html=renderToStaticMarkup(createElement(AITranscript,{snapshot}));
  assert.equal((html.match(/class="turn-current-step"/g)||[]).length,0);
  assert.ok(html.includes('<span class="thinking-label">Local machine</span>'));
  assert.ok(html.includes('class="turn-execution-details is-open" aria-hidden="false"'));
  assert.ok(!html.includes("VERY_VERBOSE_RAW_REASONING"));
  assert.equal((html.match(/turn-status-text/g)||[]).length,1);
  assert.ok(html.indexOf("正在执行工具…")<html.indexOf("Local machine"));
});

test("compaction limit failures display one Chinese message with history-preservation guidance",()=>{
 const error="context compaction: model output limit reached; incomplete response discarded";
 const snapshot={session:{id:"demo"},messages:[{id:"user",role:"user",createdAt:start,text:"cpu呢"},{id:"system-copy",role:"system",createdAt:start,text:error}],actions:[],ai:{session:"demo",status:"failed",startedAt:start,cards:[{id:"error-card",type:"error",content:error,status:"failed",at:start}],cardsOffset:0}} as SessionSnapshot;
 const html=renderToStaticMarkup(createElement(AITranscript,{snapshot}));
 assert.equal(html.split("上下文整理未完成").length-1,1);
 assert.ok(html.includes("历史记录已保留"));assert.ok(!html.includes("incomplete response discarded"));
});

test("plain output-limit errors are localized and retain original-session recovery guidance",()=>{
 const message=displayAiError("model output limit reached; incomplete response discarded");
 assert.ok(message.includes("单次输出上限") && message.includes("原会话继续"));
 assert.ok(!message.includes("incomplete response"));
});
test("automatic output recovery shows a single notice while previous compaction hints stay hidden",()=>{
 const snapshot={session:{id:"demo"},messages:[{id:"user",role:"user",createdAt:start,text:"继续调查"}],actions:[],ai:{session:"demo",status:"running",cards:[{id:"retry",type:"notice",content:"模型回复达到单次输出上限，正在缩短回复后重试；已完成的操作保留",status:"completed",at:start}],cardsOffset:0}} as SessionSnapshot;
 assert.ok(renderToStaticMarkup(createElement(AITranscript,{snapshot})).includes("正在缩短回复后重试"));
});
