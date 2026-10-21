import assert from "node:assert/strict";
import test from "node:test";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import type {AICard,ReplyTiming,SessionSnapshot} from "../../shared/contracts";
import {replyDurationText,timingForTurn} from "../src/replyDurationState";
import {AITranscript} from "../src/AIPanel";
import {ReplyDuration} from "../src/ReplyDuration";
import {TurnExecutionDetails} from "../src/TurnExecutionDetails";

const start="2026-10-12T03:00:00Z";
const timing:ReplyTiming={messageId:"u",startedAt:start,finishedAt:"2026-10-12T03:01:13Z",status:"completed"};
test("completed duration stays frozen and sub-second durations stay hidden",()=>{
 assert.equal(replyDurationText(timing,Date.parse(start)+9_000_000),"1分钟 13秒 · 已完成");
 assert.equal(replyDurationText({...timing,finishedAt:start},Date.now()),undefined);
 assert.equal(replyDurationText({...timing,status:"running",finishedAt:""},Date.parse(start)+19000),"19秒 · 正在思考…");
 assert.equal(replyDurationText({...timing,status:"running"},Date.parse(start)+19000,true),"19秒 · 等待确认");
});
test("normal activity waits one second and instant completion does not flash a duration",t=>{
 let now=Date.parse(start);
 t.mock.method(Date,"now",()=>now);
 const running={...timing,status:"running" as const,finishedAt:""};
 const render=(props:Parameters<typeof ReplyDuration>[0])=>renderToStaticMarkup(createElement(ReplyDuration,props));
 for(const elapsed of [0,500,999]){
  now=Date.parse(start)+elapsed;
  assert.equal(render({timing:running}),"");
  assert.equal(render({view:{status:"running",turnStartedAt:start,cards:[]} as never}),"");
 }
 now=Date.parse(start)+1000;
 const active=render({timing:running});
 assert.ok(active.includes("reply-duration-spinner")&&active.includes("用时 1秒")&&active.includes("正在思考…"));
 const quick={...timing,finishedAt:"2026-10-12T03:00:00.999Z"};
 assert.equal(render({timing:quick}),"");
 assert.ok(render({timing:{...quick,status:"failed"}}).includes("未完成"));
 now=Date.parse(start)+100;
 const waiting=render({timing:running,view:{status:"waiting_approval",cards:[]} as never});
 assert.ok(waiting.includes("等待确认")&&!waiting.includes("reply-duration-spinner"));
 assert.ok(!waiting.includes("不到1秒"));
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
 assert.ok(html.includes("用时 1分钟 13秒"));assert.ok(html.includes("用时 4秒"));assert.ok(!html.includes("已处理"));
 const legacy={...snapshot,replyTimings:undefined};
 assert.equal(timingForTurn([{id:"u",at:start,message:snapshot.messages[0]}],legacy),undefined);
 assert.equal(timingForTurn([{id:"v",at:snapshot.messages[1]!.createdAt,message:snapshot.messages[1]}],legacy)?.finishedAt,snapshot.ai!.turnFinishedAt);
});

test("waiting for first model data already has visible motion, independent of idle engine state",()=>{
 const snapshot={session:{id:"s"},messages:[{id:"u",role:"user",text:"你能看懂图片吗",createdAt:start}],resources:[],actions:[],replyTimings:[{...timing,status:"running",finishedAt:""}],ai:{session:"s",status:"idle",cards:[],cardsOffset:0}} as SessionSnapshot;
 const html=renderToStaticMarkup(createElement(AITranscript,{snapshot}));
 assert.ok(html.includes("reply-duration-spinner") && html.includes("正在思考…"));
 const completed=renderToStaticMarkup(createElement(AITranscript,{snapshot:{...snapshot,replyTimings:[timing]}}));
 assert.ok(!completed.includes("reply-duration-spinner") && completed.includes("用时 1分钟 13秒")&&!completed.includes("reply-duration-clock"));
 assert.ok(!completed.includes("回复结束")&&!completed.includes("turn-status-mark"),"finished timing uses a quiet Chinese elapsed caption without an icon or repeated completion label");
});

test("quiet completion never conceals uncertain outcomes or invents a duration",()=>{
 const render=(props:Parameters<typeof ReplyDuration>[0])=>renderToStaticMarkup(createElement(ReplyDuration,props));
 assert.equal(render({view:{status:'completed',cards:[]} as never}),'',"missing timing does not become a made-up elapsed caption");
 const uncertain=render({timing,cards:[{id:'op',at:start,type:'operation',status:'unknown'}]});
 assert.ok(uncertain.includes('用时 1分钟 13秒')&&!uncertain.includes('reply-duration-clock')&&uncertain.includes('执行结果待核查'));
 for(const [status,label] of [['cancelled','已停止'],['failed','未完成'],['interrupted','记录已中断']] as const){
  assert.ok(render({timing:{...timing,status}}).includes(label));
 }
});


test('elapsed disclosure matches the Chinese reference and exposes a real accessible control',()=>{
 const html=renderToStaticMarkup(createElement(ReplyDuration,{timing:{...timing,finishedAt:'2026-10-12T03:09:54Z'},disclosure:{open:false,controls:'execution-steps',onToggle:()=>{}}}));
 assert.ok(html.includes('用时 9分钟 54秒'));
 assert.ok(html.includes('aria-expanded="false"')&&html.includes('aria-controls="execution-steps"'));
 assert.ok(html.includes('turn-duration-chevron')&&!html.includes('reply-duration-clock'));
 const unknown=renderToStaticMarkup(createElement(ReplyDuration,{disclosure:{open:false,controls:'old-steps',onToggle:()=>{}}}));
 assert.ok(unknown.includes('执行过程')&&!unknown.includes('用时'),'old records without timing still expose their recorded steps without an invented duration');
});


test('live elapsed time, separator and state share one sweep while confirmation and completion stay static',()=>{
 const running={...timing,status:'running' as const,finishedAt:''};
 const html=renderToStaticMarkup(createElement(ReplyDuration,{timing:running}));
 const active=html.match(/<span class="status-text status-text--active [^"]*">([\s\S]*?)<\/span><\/span>/)?.[1]??'';
 assert.ok(active.includes('turn-status-elapsed')&&active.includes('用时 '));
 assert.ok(active.includes(' · ')&&active.includes('正在思考…'));
 assert.equal((html.match(/status-text--active/g)||[]).length,1);
 const waiting=renderToStaticMarkup(createElement(ReplyDuration,{timing:running,view:{status:'waiting_approval',cards:[]} as never}));
 const ended=renderToStaticMarkup(createElement(ReplyDuration,{timing}));
 assert.ok(!waiting.includes('status-text--active')&&!ended.includes('status-text--active'));
});

test('finished metadata drops the last operation caption even when saved cards still say running',()=>{
 const latest:AICard={id:'op',type:'operation',title:'shell',status:'running',at:start,data:{target:'演示主机',arguments:{command:'uptime'}}};
 for(const status of ['completed','failed','cancelled','interrupted'] as const){
  const html=renderToStaticMarkup(createElement(TurnExecutionDetails,{timing:{...timing,status},view:{status:'running',cards:[latest]} as never,cards:[latest],detailNotice:'2 项未执行',details:[createElement('span',{key:'details'},'完整过程')]}));
  assert.ok(!html.includes('turn-current-step')&&!html.includes('最新步骤：'),status);
  assert.ok(html.includes('2 项未执行')&&html.includes('aria-expanded="false"'),status);
  assert.ok(html.includes('完整过程')&&html.includes('aria-hidden="true" inert=""'),'history is retained for manual review');
 }
});

test('latest-step caption hides while expanded and stops sweeping on attention or completion',()=>{
 const latestStep:AICard={id:'sql',type:'operation',title:'execute_sql',status:'running',at:start,data:{target:'演示数据库'}};
 const disclosure={open:false,controls:'steps',onToggle:()=>{}};
 const render=(props:Parameters<typeof ReplyDuration>[0])=>renderToStaticMarkup(createElement(ReplyDuration,props));
 const running={...timing,status:'running' as const,finishedAt:''};
 assert.ok(render({timing:running,latestStep,disclosure}).includes('execution-icon-water'));
 const returned=render({timing:running,latestStep:{...latestStep,status:'completed'},disclosure});
 assert.ok(returned.includes('status-text--active turn-current-step-label')&&returned.includes('execution-icon-water'));
 assert.ok(!render({timing:running,view:{status:'waiting_approval',cards:[]} as never,latestStep,disclosure}).includes('execution-icon-water'));
 const open=render({timing:running,latestStep,detailNotice:'2 项失败',disclosure:{...disclosure,open:true}});
 assert.ok(!open.includes('turn-current-step')&&open.includes('2 项失败')&&open.includes('aria-expanded="true"'));
 for(const status of ['failed','pending','unknown','background_running','not_executed','cancelled'] as const){
  const html=render({timing:running,latestStep:{...latestStep,status},disclosure});
  assert.ok(html.includes('最新步骤：执行 SQL · 演示数据库'));
  assert.ok(!html.includes('status-text--active turn-current-step-label'),status);
  assert.ok(!html.includes('execution-icon-water'),status);
 }
 const ended=render({timing,latestStep:{...latestStep,status:'completed'},disclosure});
 assert.ok(!ended.includes('turn-current-step')&&!ended.includes('status-text--active'));
 assert.ok(!render({timing,latestStep,disclosure}).includes('execution-icon-water'),'stale running records stay static after the turn ends');
});
