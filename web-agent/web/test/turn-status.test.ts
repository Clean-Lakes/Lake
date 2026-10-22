import test from "node:test";
import assert from "node:assert/strict";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import type {AICard,AIView,ReplyTiming,SessionSnapshot} from "../../shared/contracts";
import {turnStatus} from "../src/turnStatus";
import {processDescription} from "../src/activity";
import {ThinkingTimeline} from "../src/ThinkingTimeline";
import {AITranscript} from "../src/AIPanel";
const at="2026-10-14T03:00:00Z";
const now=Date.parse(at)+49_000;
const timing:ReplyTiming={messageId:"u",startedAt:at,finishedAt:"",status:"running"};
const view={session:"s",status:"running",turnStartedAt:at,cards:[],cardsOffset:0} as AIView;
const tool:AICard={id:"op",type:"operation",title:"read",at,status:"running",data:{arguments:{path:"/etc/example.conf"},target:"测试主机"}};
test("one footer transitions from initial waiting to thinking, tools, streaming, approval and completion",()=>{
 assert.equal(turnStatus(timing,{...view,status:"idle"},[],at,now).text,"49秒 · 正在思考…");
 assert.equal(turnStatus(timing,view,[tool],at,now).state,"正在执行工具…");
 assert.equal(turnStatus(timing,view,[{...tool,status:"completed"},{id:"reply",at,type:"message",status:"running",content:"答复"}],at,now).state,"正在生成回复…");
 assert.equal(turnStatus(timing,view,[{...tool,status:"pending"}],at,now).state,"等待确认");
 assert.equal(turnStatus(timing,{...view,question:{id:"q",questions:[]}},[],at,now).state,"等待你的选择");
 const saved={...timing,status:"completed" as const,finishedAt:new Date(now).toISOString()};
 assert.equal(turnStatus(saved,view,[],at,now+500000).text,"49秒 · 回复结束");
 assert.equal(turnStatus(saved,view,[],at,now).live,false,"stored completion wins over a delayed engine snapshot");
});
test("old pending tools and foreign or earlier agent runs cannot become the current status",()=>{
 assert.equal(turnStatus(timing,view,[{...tool,status:"pending",at:"2026-10-13T00:00:00Z"}],at,now).state,"正在思考…");
 const run={id:"r",sessionId:"s",rootTurnId:"turn",role:"host",task:"检查",resourceIds:[],createdAt:at,status:"running" as const};
 const v={...view,rootTurnId:"turn",agentRuns:[run,{...run,id:"foreign",sessionId:"other"},{...run,id:"old",rootTurnId:"old"}]};
 assert.equal(turnStatus(timing,v,[],at,now).state,"1 个子任务执行中…");
 assert.equal(turnStatus(timing,{...v,agentRuns:[{...run,status:"waiting_approval"}]},[],at,now).state,"等待确认");
 assert.equal(turnStatus({...timing,status:"cancelled",finishedAt:new Date(now).toISOString()},v,[],at,now).text,"49秒 · 已停止");
});
test("current compaction has one live footer even when its card is hidden from the transcript",()=>{
 const compact:AICard={id:"compact",type:"compaction",content:"正在压缩上下文…",status:"running",at};
 const v={...view,cards:[compact]};
 assert.equal(turnStatus(timing,v,[],at,now).text,"49秒 · 正在压缩上下文…");
 assert.equal(turnStatus(timing,{...v,cards:[{...compact,at:"2026-10-13T00:00:00Z"}]},[],at,now).state,"正在思考…");
 assert.equal(turnStatus(timing,{...v,cards:[{...compact,status:"completed"}]},[],at,now).state,"正在思考…");
 assert.equal(turnStatus({...timing,status:"cancelled",finishedAt:new Date(now).toISOString()},v,[],at,now).state,"已停止");
 const snapshot={session:{id:"s"},messages:[{id:"u",sessionId:"s",role:"user",text:"继续检查",createdAt:at}],resources:[],actions:[],replyTimings:[timing],ai:v} as SessionSnapshot;
 const html=renderToStaticMarkup(createElement(AITranscript,{snapshot}));
 assert.equal(html.split("正在压缩上下文…").length-1,1);
 assert.equal((html.match(/class="reply-duration /g)||[]).length,1);
});
test("unverified and background results stay honest; missing endpoints never invent elapsed time",()=>{
 const saved={...timing,status:"completed" as const,finishedAt:new Date(now).toISOString()};
 assert.equal(turnStatus(saved,undefined,[{...tool,status:"unknown"}],at,now).text,"49秒 · 执行结果待核查");
 assert.equal(turnStatus(saved,undefined,[{...tool,status:"background_running"}],at,now).state,"后台命令仍在执行");
 assert.equal(turnStatus({...saved,finishedAt:""},undefined,[],at,now).duration,undefined);
 assert.equal(turnStatus({...saved,status:"interrupted"},undefined,[],at,now).text,"记录已中断");
 assert.equal(turnStatus(undefined,undefined,[{id:"reply",at,type:"message",status:"completed",content:"历史答复"}],at,now).text,"回复结束");
});
test("light process labels name the file and target, bound repeated operations and omit raw commands",()=>{
 assert.equal(processDescription([tool]),"读取 example.conf · 测试主机");
 assert.equal(processDescription([tool,{...tool,id:"op2"}]),"读取 example.conf · 测试主机（2 次）");
 const summary=processDescription([{...tool,title:"shell",data:{arguments:{command:"RAW_COMMAND_CONTENT"},target:"测试主机"}}]);
 assert.equal(summary,"执行命令 · 测试主机");assert.ok(!summary.includes("RAW_COMMAND_CONTENT"));
 const describe=(command:string)=>processDescription([{...tool,title:"shell",data:{arguments:{command},target:"测试主机"}}]);
 assert.equal(describe("uname -a; free -m; systemctl status nginx"),"检查系统与资源、检查服务状态 · 测试主机");
 assert.equal(describe("mysql -e 'SHOW DATABASES'"),"执行数据库命令 · 测试主机");
 assert.equal(describe("echo '\nfree -m\n'"),"执行命令 · 测试主机");
 assert.equal(describe("# free -m\necho done"),"执行命令 · 测试主机");
 assert.equal(describe("echo uname; systemctl restart nginx"),"执行命令 · 测试主机","a mention and a service mutation are not a read-only inspection");
});
test("the single metadata row precedes the reply, file changes and todos; activity filtering cannot borrow a newer turn state",()=>{
 const s={session:{id:"s"},messages:[{id:"u",sessionId:"s",role:"user",text:"检查",createdAt:at}],resources:[],actions:[],evidence:[],specialists:[],replyTimings:[timing],ai:{...view,todos:[{content:"步骤已完成",status:"completed"}],cards:[{id:"todo",type:"operation",title:"todo_write",status:"completed",at,data:{arguments:{todos:[{content:"步骤已完成",status:"completed"}]}}},{...tool,status:"completed"},{id:"reply",type:"message",status:"running",content:"最后的回复",at},{id:"edit",type:"diff",status:"completed",title:"example.conf",at,data:{before:"before",after:"after"}}]}} as SessionSnapshot;
 const html=renderToStaticMarkup(createElement(AITranscript,{snapshot:s}));
 assert.equal((html.match(/class="reply-duration /g)||[]).length,1);
 assert.ok(html.includes('步骤已完成'));
 assert.ok(html.indexOf('class="reply-duration ')<html.indexOf("步骤已完成"));
 assert.ok(html.indexOf('class="reply-duration ')<html.indexOf("最后的回复"));
 assert.ok(!html.includes("file-changes"),"file summary waits until the running turn ends");
 s.messages.push({id:"v",sessionId:"s",role:"user",text:"新提问",createdAt:"2026-10-14T03:01:00Z"});
 s.replyTimings=undefined;s.ai!.cards=[{...tool,status:"completed"}];s.ai!.turnStartedAt=s.messages[1]!.createdAt;
 const activity=renderToStaticMarkup(createElement(AITranscript,{snapshot:s,mode:"activity"}));
 assert.ok(!activity.includes("reply-duration-spinner"),"the only shown activity is historical");
});

test('each turn starts with its own metadata after the user message and before the reply',()=>{
 const old='2026-10-14T02:00:00Z';
 const snapshot={session:{id:'s'},messages:[{id:'old',sessionId:'s',role:'user',text:'历史问题',createdAt:old},{id:'u',sessionId:'s',role:'user',text:'当前问题',createdAt:at}],resources:[],actions:[],replyTimings:[{messageId:'old',startedAt:old,finishedAt:'2026-10-14T02:00:02Z',status:'completed'},{...timing,status:'completed',finishedAt:'2026-10-14T03:00:49Z'}],ai:{...view,status:'completed',cards:[{id:'old-reply',type:'message',status:'completed',content:'历史答复',at:old},{...tool,status:'completed'},{id:'reply',type:'message',status:'completed',content:'本轮答复',at}]}} as SessionSnapshot;
 const html=renderToStaticMarkup(createElement(AITranscript,{snapshot}));
 const older=html.slice(html.indexOf('id="conversation-turn-s-old"'),html.indexOf('id="conversation-turn-s-u"'));
 const current=html.slice(html.indexOf('id="conversation-turn-s-u"'));
 assert.ok(older.indexOf('历史问题')<older.indexOf('2秒')&&older.indexOf('2秒')<older.indexOf('历史答复'));
 assert.ok(current.indexOf('当前问题')<current.indexOf('49秒')&&current.indexOf('49秒')<current.indexOf('本轮答复'));
 assert.equal((html.match(/aria-label="回答耗时"/g)||[]).length,2);
 assert.ok(!older.includes('49秒')&&!current.includes('2秒'));
});
test('only actual running operations receive the stronger execution motion',()=>{
 const render=(status:string,live:boolean)=>renderToStaticMarkup(createElement(ThinkingTimeline,{cards:[{...tool,status}],live,resourceRow:true}));
 assert.ok(render('running',true).includes('is-executing'));
 assert.ok(!render('running',false).includes('is-executing'));
 for(const status of ['pending','failed','unknown','completed','background_running'])assert.ok(!render(status,true).includes('is-executing'),status);
});

test('the current normal progress row keeps moving while the model prepares its next step',()=>{
 const s={session:{id:'s'},messages:[{id:'u',sessionId:'s',role:'user',text:'检查',createdAt:at}],resources:[],actions:[],replyTimings:[timing],ai:{...view,cards:[{...tool,status:'completed'},{id:'empty-thinking',type:'thinking',status:'running',at,content:''}]}} as SessionSnapshot;
 const html=renderToStaticMarkup(createElement(AITranscript,{snapshot:s}));
 assert.equal((html.match(/is-continuing/g)??[]).length,1);
 assert.ok(!html.includes('is-executing'),'a completed tool is not labeled as executing');
 s.ai!.cards.push({id:'reply',type:'message',status:'running',at,content:'根据结果继续分析'});
 assert.ok(renderToStaticMarkup(createElement(AITranscript,{snapshot:s})).includes('is-continuing'),'generated prose must not stop the current sweep before the turn finishes');
 s.ai!.cards.pop();s.replyTimings=[{...timing,status:'completed',finishedAt:new Date(now).toISOString()}];s.ai!.status='completed';
 assert.ok(!renderToStaticMarkup(createElement(AITranscript,{snapshot:s})).includes('is-continuing'));
});
test('waiting, failed and unknown progress rows never borrow the continuing motion',()=>{
 for(const status of ['pending','failed','unknown','background_running']){
  const html=renderToStaticMarkup(createElement(ThinkingTimeline,{cards:[{...tool,status}],live:true,continuing:true,resourceRow:true}));
  assert.ok(!html.includes('is-continuing'),status);
 }
});
