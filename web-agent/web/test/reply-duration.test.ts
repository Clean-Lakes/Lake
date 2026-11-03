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
test("thinking identity appears immediately while brief tool activity and elapsed captions stay quiet",t=>{
 let now=Date.parse(start);
 t.mock.method(Date,"now",()=>now);
 const running={...timing,status:"running" as const,finishedAt:""};
 const render=(props:Parameters<typeof ReplyDuration>[0])=>renderToStaticMarkup(createElement(ReplyDuration,props));
 for(const elapsed of [0,500,999]){
  now=Date.parse(start)+elapsed;
  for(const html of [render({timing:running}),render({view:{status:"running",turnStartedAt:start,cards:[]} as never})]){
   assert.ok(html.includes('turn-thinking-avatar')&&html.includes('turn-thinking-dots'));
   assert.ok(!html.includes('reply-duration-spinner')&&!html.includes('turn-status-elapsed'));
  }
  assert.equal(render({timing:running,cards:[{id:'tool',type:'operation',status:'running',at:start}]}),'');
 }
 now=Date.parse(start)+1000;
 const active=render({timing:running});
 assert.ok(active.includes("turn-thinking-dots")&&!active.includes("用时")&&active.includes("正在思考…"));
 const quick={...timing,finishedAt:"2026-10-12T03:00:00.999Z"};
 assert.equal(render({timing:quick}),"");
 assert.ok(render({timing:{...quick,status:"failed"}}).includes("未完成"));
 now=Date.parse(start)+100;
 const waiting=render({timing:running,view:{status:"waiting_approval",cards:[]} as never});
 assert.ok(waiting.includes("等待确认")&&!waiting.includes("reply-duration-spinner"));
 assert.ok(!waiting.includes("不到1秒"));
});

test('Pilot and specialist identities survive initial, empty-stream and reasoning snapshots without the old animation',t=>{
 t.mock.method(Date,'now',()=>Date.parse(start)+100);
 for(const assistantIdentity of [{name:'Pilot',pilot:true},{name:'服务器运维排查专员'}]){
  for(const cards of [[],[{id:'empty',type:'message',status:'running',content:'',at:start}],[{id:'empty-text',type:'text',status:'running',content:'  ',at:start}],[{id:'reasoning',type:'thinking',status:'running',content:'',at:start}]] as AICard[][]){
   const snapshot={session:{id:'s'},messages:[{id:'u',sessionId:'s',role:'user',text:'继续',createdAt:start}],resources:[],actions:[],replyTimings:[{...timing,status:'running',finishedAt:''}],ai:{session:'s',status:cards.length?'running':'idle',turnStartedAt:start,cards,cardsOffset:0}} as SessionSnapshot;
   const html=renderToStaticMarkup(createElement(AITranscript,{snapshot,assistantIdentity}));
   if(assistantIdentity.pilot)assert.ok(html.slice(html.indexOf('turn-thinking-avatar')).includes('data-role="coordinator"'));
   else assert.ok(!html.includes('turn-thinking-avatar')&&html.includes('data-reply-avatar="hidden"'));
   assert.ok(html.includes('turn-thinking-dots')&&!html.includes('reply-duration-spinner'));
   assert.equal((html.match(/class="response-avatar"/g)||[]).length,assistantIdentity.pilot?1:0,'empty reply placeholders do not add another blank identity bubble');
  }
 }
});

test('a direct specialist supplement shows dots without saved timing or a new task root',t=>{
 t.mock.method(Date,'now',()=>Date.parse(start)+2000);
 const userAt=new Date(Date.parse(start)+1000).toISOString();
 const snapshot={session:{id:'worker',workspaceRole:'worker'},messages:[{id:'followup',sessionId:'worker',role:'user',text:'为什么受阻？',createdAt:userAt}],resources:[],actions:[],replyTimings:[],superagent:{task:{state:'blocked'},goal:{status:'blocked'}},ai:{session:'worker',status:'running',replyStatus:'running',rootTurnId:'original-task-root',turnStartedAt:start,cards:[],cardsOffset:0,workGoals:[{id:'original-task',status:'blocked'}]}} as unknown as SessionSnapshot;
 const render=(s:SessionSnapshot)=>renderToStaticMarkup(createElement(AITranscript,{snapshot:s,assistantIdentity:{name:'服务器运维排查专员'}}));
 const active=render(snapshot);
 assert.ok(active.includes('turn-thinking-dots')&&active.includes('data-reply-avatar="hidden"'));
 assert.ok(!active.includes('response-avatar')&&!active.includes('turn-thinking-avatar'));
 const ended=render({...snapshot,ai:{...snapshot.ai!,status:'blocked',replyStatus:undefined,turnFinishedAt:new Date().toISOString()}});
 assert.ok(!ended.includes('turn-thinking-dots'),'business blockage alone must not invent a live reply');
 assert.equal(snapshot.superagent!.goal!.status,'blocked');
 assert.equal(snapshot.ai!.rootTurnId,'original-task-root');
});
test('direct specialist compaction uses dots immediately and preserves approval, stop and completion states',t=>{
 const userAt=new Date(Date.parse(start)+1000).toISOString();
 const compact:AICard={id:'compact',type:'compaction',status:'running',content:'正在压缩上下文…',at:userAt};
 const snapshot={session:{id:'worker',workspaceRole:'worker'},messages:[{id:'followup',sessionId:'worker',role:'user',text:'为什么？',createdAt:userAt}],resources:[],actions:[],replyTimings:[],ai:{session:'worker',status:'running',replyStatus:'running',rootTurnId:'original-task-root',turnStartedAt:start,cards:[compact],cardsOffset:0}} as SessionSnapshot;
 const render=()=>renderToStaticMarkup(createElement(AITranscript,{snapshot,assistantIdentity:{name:'服务器运维排查专员'}}));
 for(const elapsed of [0,3000]){
  t.mock.method(Date,'now',()=>Date.parse(userAt)+elapsed);
  const html=render();
  assert.equal((html.match(/class="reply-duration /g)||[]).length,1);
  assert.ok(html.includes('turn-thinking-dots')&&!html.includes('reply-duration-spinner')&&!html.includes('status-text--active'));
  assert.ok(html.includes('role="status" aria-live="polite">正在压缩上下文…'));
  assert.ok(!html.includes('turn-thinking-avatar'));
 }
 snapshot.ai!.status='waiting_approval';
 assert.ok(render().includes('等待确认')&&!render().includes('turn-thinking-dots'));
 snapshot.ai!.status='cancelled';
 assert.ok(render().includes('已停止')&&!render().includes('turn-thinking-dots'),'a stale running compaction card cannot keep a stopped turn busy');
 snapshot.ai!.status='running';compact.status='completed';
 assert.ok(render().includes('turn-thinking-dots')&&!render().includes('正在压缩上下文'),'after compaction the same bubble continues with normal thinking');
 snapshot.ai!.cards.push({id:'reply',type:'message',status:'running',content:'这是答复',at:new Date(Date.parse(userAt)+3000).toISOString()});
 assert.ok(!render().includes('turn-thinking-dots'),'real prose ends the waiting bubble');
 snapshot.ai!.status='completed';
 assert.ok(!render().includes('turn-thinking-dots'));
});
test("cancelled and failed turns are identified; unknown endpoints do not fabricate time",()=>{
 assert.equal(replyDurationText({...timing,status:"cancelled"},Date.now()),"1分钟 13秒 · 已停止");
 assert.equal(replyDurationText({...timing,status:"failed"},Date.now()),"1分钟 13秒 · 未完成");
 assert.equal(replyDurationText({...timing,status:"interrupted",finishedAt:""},Date.now()),undefined);
 assert.equal(replyDurationText({...timing,finishedAt:""},Date.now()),undefined);
 assert.equal(replyDurationText({...timing,startedAt:"invalid"},Date.now()),undefined);
 assert.equal(replyDurationText({...timing,finishedAt:"2026-10-12T02:00:00Z"},Date.now()),undefined);
});
test('streamed prose replaces the model waiting row while details and real tool activity remain available',t=>{
 t.mock.method(Date,'now',()=>Date.parse(start)+4000);
 for(const pilot of [false,true])for(const type of ['message','text'] as const){
  const cards:AICard[]=[{id:'reply',type,status:'running',content:'请问你想继续检查这台主机吗？',at:start}];
  const snapshot={session:{id:'stream',workspaceRole:pilot?'router':'worker'},messages:[{id:'u',sessionId:'stream',role:'user',text:'a',createdAt:start}],resources:[],actions:[],replyTimings:pilot?[{...timing,status:'running',finishedAt:''}]:[],ai:{session:'stream',status:'running',turnStartedAt:start,cards,cardsOffset:0}} as SessionSnapshot;
  const html=renderToStaticMarkup(createElement(AITranscript,{snapshot,assistantIdentity:{name:pilot?'Pilot':'服务器运维排查专员',pilot}}));
  assert.ok(html.includes(cards[0]!.content!));
  assert.ok(!html.includes('正在生成回复')&&!html.includes('reply-duration-spinner')&&!html.includes('turn-thinking-dots')&&!html.includes('class="reply-duration '),'plain model streaming needs no second activity row');
  const props={timing:{...timing,status:'running' as const,finishedAt:''},view:snapshot.ai,cards,latestUserAt:start};
  const details=renderToStaticMarkup(createElement(ReplyDuration,{...props,disclosure:{open:false,controls:'steps',onToggle:()=>{}}}));
  assert.ok(details.includes('执行过程')&&details.includes('aria-controls="steps"'));
  assert.ok(!details.includes('正在生成回复')&&!details.includes('reply-duration-spinner')&&!details.includes('status-text--active'));
  const notice=renderToStaticMarkup(createElement(ReplyDuration,{...props,timing:pilot?props.timing:undefined,detailNotice:'1 项结果待核查'}));
  assert.ok(notice.includes('1 项结果待核查')&&!notice.includes('正在生成回复'),'quiet model output must preserve execution warnings even without saved timing');
  const tool:AICard={id:'tool',type:'operation',title:'inspect_host',status:'running',at:start};
  const operating=renderToStaticMarkup(createElement(ReplyDuration,{...props,cards:[tool,...cards]}));
  assert.ok(operating.includes('正在执行工具'),'real running tools must not be hidden merely because prose arrived');
 }
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
 assert.ok(html.includes("turn-thinking-dots") && html.includes("正在思考…"));
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


test('thinking uses three accessible dots; tool activity keeps elapsed text and completion freezes it',t=>{
 t.mock.method(Date,'now',()=>Date.parse(start)+19000);
 const running={...timing,status:'running' as const,finishedAt:''};
 const html=renderToStaticMarkup(createElement(ReplyDuration,{timing:running}));
 assert.ok(html.includes('turn-thinking-bubble')&&html.includes('class="visually-hidden" role="status"'));
 assert.equal((html.match(/<i>/g)||[]).length,3);
 assert.ok(html.includes('title="正在思考 · 已处理 19秒"'));
 assert.ok(!html.includes('turn-status-elapsed')&&!html.includes('reply-duration-spinner')&&!html.includes('status-text--active'));
 const tool:AICard={id:'tool',type:'operation',title:'inspect_host',status:'running',at:start};
 const toolHTML=renderToStaticMarkup(createElement(ReplyDuration,{timing:running,cards:[tool]}));
 const active=toolHTML.match(/<span class="status-text status-text--active [^"]*">([\s\S]*?)<\/span><\/span>/)?.[1]??'';
 assert.ok(active.includes('turn-status-elapsed')&&active.includes('已处理 19秒')&&!active.includes('用时 '));
 assert.ok(active.includes('正在执行工具…'));
 assert.equal((toolHTML.match(/status-text--active/g)||[]).length,1);
 const waiting=renderToStaticMarkup(createElement(ReplyDuration,{timing:running,view:{status:'waiting_approval',cards:[]} as never}));
 const ended=renderToStaticMarkup(createElement(ReplyDuration,{timing}));
 assert.ok(ended.includes('用时 1分钟 13秒'));
 assert.ok(!waiting.includes('status-text--active')&&!ended.includes('status-text--active'));
 const previewAt=Date.parse(start)+19000;
 const preview=renderToStaticMarkup(createElement(ReplyDuration,{timing:running,previewAt}));
 assert.ok(preview.includes('用时 19秒')&&preview.includes('is-preview'));
 assert.ok(!preview.includes('已完成')&&!preview.includes('status-text--active')&&!preview.includes('reply-duration-spinner'));
 t.mock.method(Date,'now',()=>Date.parse(start)+45000);
 assert.equal(renderToStaticMarkup(createElement(ReplyDuration,{timing:running,previewAt})),preview,'reply streaming does not advance the preview clock');
 assert.ok(renderToStaticMarkup(createElement(ReplyDuration,{timing,previewAt})).includes('用时 1分钟 13秒'),'saved total replaces the preview only after real completion');
});

test('typing bubble preserves detail access and yields to approval and final timing',()=>{
 const running={...timing,status:'running' as const,finishedAt:''};
 const disclosure={open:false,controls:'steps',side:true,onToggle:()=>{}};
 const render=(props:Parameters<typeof ReplyDuration>[0])=>renderToStaticMarkup(createElement(ReplyDuration,props));
 const thinking=render({timing:running,disclosure});
 assert.ok(thinking.includes('aria-label="查看执行详细过程"')&&thinking.includes('aria-controls="steps"'));
 for(const html of [render({timing:running,view:{status:'waiting_approval',cards:[]} as never,disclosure}),render({timing:{...timing,status:'failed'}}),render({timing}),render({timing:running,previewAt:Date.parse(start)+19000})]){
  assert.ok(!html.includes('turn-thinking-bubble'));
 }
 assert.ok(render({timing:running,view:{status:'waiting_approval',cards:[]} as never}).includes('等待确认'));
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

test('Pilot elapsed header does not repeat specialist activity or invent missing timing',t=>{
 t.mock.method(Date,'now',()=>Date.parse(start)+19000);
 const running={...timing,status:'running' as const,finishedAt:''};
 const html=renderToStaticMarkup(createElement(ReplyDuration,{timing:running,elapsedOnly:true,view:{status:'running',cards:[],agentRuns:[{sessionId:'s',status:'running',createdAt:start}],session:'s'} as never}));
 assert.ok(html.includes('已处理 19秒'));
 assert.ok(!html.includes('子任务执行中')&&!html.includes('reply-duration-spinner'));
 assert.equal(renderToStaticMarkup(createElement(ReplyDuration,{elapsedOnly:true,view:{status:'running',cards:[]} as never})), '');
});

test('a completed timed reply shows elapsed time without a redundant completion label',()=>{
 const html=renderToStaticMarkup(createElement(ReplyDuration,{timing}));
 assert.ok(html.includes('用时 1分钟 13秒')&&!html.includes('已完成')&&!html.includes('未完成'));
 assert.ok(!html.includes(' · '),'normal completion has no dangling separator');
 const failed=renderToStaticMarkup(createElement(ReplyDuration,{timing:{...timing,status:'failed'}}));
 assert.ok(failed.includes('未完成')&&!failed.includes('已完成'));
});

test('side detail entry keeps a horizontal navigation arrow while inline disclosure retains its direction',()=>{
 for(const open of [false,true]){
  const html=renderToStaticMarkup(createElement(ReplyDuration,{timing,disclosure:{open,side:true,controls:'session-task-inspector',onToggle:()=>{}}}));
  assert.ok(html.includes('data-placement="side"')&&html.includes('在右侧查看执行详细过程'));
  assert.ok(html.includes(`aria-expanded="${open}"`)&&html.includes('aria-controls="session-task-inspector"'));
 }
 const inline=renderToStaticMarkup(createElement(ReplyDuration,{timing,disclosure:{open:true,controls:'inline-details',onToggle:()=>{}}}));
 assert.ok(inline.includes('data-placement="inline"')&&inline.includes('收起执行详细过程'));
});

test('Pilot hides the running turn timer without reserving space and restores ordinary finished timing',()=>{
 const body=createElement('p',{},'专员正文');
 const live=renderToStaticMarkup(createElement(TurnExecutionDetails,{hideLive:true,timing:{...timing,status:'running',finishedAt:''},details:[],children:body}));
 assert.equal(live,'<p>专员正文</p>');
 const ended=renderToStaticMarkup(createElement(TurnExecutionDetails,{hideLive:true,timing,details:[],children:body}));
 assert.ok(ended.includes('用时 1分钟 13秒')&&ended.includes('is-finished'));
 assert.ok(ended.indexOf('用时')<ended.indexOf('专员正文'));
});
