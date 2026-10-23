import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AITranscript } from "../src/AIPanel";
import { SessionListTags, SessionActions, SessionStateBadge } from "../src/SessionPresentation";
import { ConversationDirectory, activeDirectoryItem, conversationDirectoryItems, conversationTurnId } from "../src/ConversationDirectory";
import type { SessionSnapshot, WorkspaceTag } from "../../shared/contracts";

const at="2026-10-14T02:00:00Z";
function snapshot(): SessionSnapshot {
  return {session:{id:"s"},messages:[{id:"user",role:"user",text:"本轮问题",createdAt:at}],resources:[],terminals:[],specialists:[],actions:[],evidence:[],ai:{session:"s",status:"completed",cardsOffset:0,turns:1,profile:"core",cards:[
    {id:"tool",type:"shell",title:"shell",status:"unknown",content:"命令输出",at},
    {id:"reply",type:"text",status:"completed",content:"本轮回答",at},
    {id:"report",type:"chart",title:"调查图表",status:"completed",data:{labels:["A"],values:[12]},at},
  ]}} as SessionSnapshot;
}

test("conversation retains question and answer while activity shows actual operations and uncertainty", () => {
  const s=snapshot();
  const conversation=renderToStaticMarkup(createElement(AITranscript,{snapshot:s}));
  assert.ok(conversation.includes("本轮问题") && conversation.includes("本轮回答"));
  const activity=renderToStaticMarkup(createElement(AITranscript,{snapshot:s,mode:"activity"}));
  assert.ok(activity.includes("执行结果待核查"));
  const activityBody=activity.slice(activity.indexOf('<div class="ai-turn"'));
  assert.ok(!activityBody.includes("本轮问题") && !activityBody.includes("本轮回答") && !activityBody.includes("调查图表"));
});

test("evidence shows recorded reports and deduplicates evidence without exposing another session", () => {
  const s=snapshot();
  const own={id:"e1",sessionId:"s",specialistId:null,resourceId:"r",title:"本轮证据",command:null,excerpt:"只读输出",exitCode:0,collectedAt:at};
  s.evidence=[own,{...own,id:"foreign",sessionId:"other",title:"其他会话的证据"}];
  s.ai!.agentRuns=[{id:"run",sessionId:"s",role:"host",resourceIds:[],status:"completed",task:"调查",createdAt:at,evidence:[{...own,runId:"run"}]}];
  const html=renderToStaticMarkup(createElement(AITranscript,{snapshot:s,mode:"evidence"}));
  assert.equal(html.split("本轮证据").length-1,1);
  assert.ok(html.includes("调查图表") && html.includes("只读输出"));
  assert.ok(!html.includes("其他会话的证据") && !html.includes("本轮回答"));
});

const tags: WorkspaceTag[] = [
  {id:"mongo", projectId:"p", name:"MongoDB", color:"purple"},
  {id:"ops", projectId:"p", name:"运维排查", color:"green"},
];

test("conversation uses assigned tag colors in prose and leaves code, links and identifiers intact", () => {
  const s=snapshot();
  s.session.tags=tags;
  s.ai!.cards=[{id:"reply",type:"message",status:"completed",at,content:[
    "## MongoDB 当前状态",
    "本次**运维排查**：mongodb 运行正常。",
    "`MongoDB`、MongoDBBackup、/etc/MongoDB/conf、MongoDB.log 保持原样。",
    "[MongoDB 官网](https://example.com/MongoDB)",
    "```sh\necho MongoDB\n```",
  ].join("\n\n")}];
  const html=renderToStaticMarkup(createElement(AITranscript,{snapshot:s}));
  assert.equal((html.match(/conversation-tag color-purple/g)||[]).length,2);
  assert.equal((html.match(/conversation-tag color-green/g)||[]).length,1);
  assert.ok(html.includes('<strong><span class="conversation-tag color-green"'));
  assert.ok(html.includes('data-object-kind="software"') && html.includes('>MongoDB</span>'));
  assert.ok(html.includes('>MongoDB 官网</a>'));
  const shell=html.match(/<code class="language-sh[^\"]*">([\s\S]*?)<\/code>/)?.[1];
  assert.ok(shell);
  assert.equal(shell.replace(/<\/?span\b[^>]*>/g,''),'echo MongoDB\n');
  assert.ok(!shell.includes('conversation-tag'));
  assert.ok(html.replace(/<[^>]*>/g,'').includes('MongoDBBackup、/etc/MongoDB/conf、MongoDB.log'));
});

test("removing, recoloring and renaming session tags changes existing replies without adding unrelated tags", () => {
  const s=snapshot();
  s.ai!.cards=[{id:"reply",type:"text",status:"completed",at,content:"MongoDB 运维排查"}];
  s.session.tags=[tags[0]!];
  const render=()=>renderToStaticMarkup(createElement(AITranscript,{snapshot:s}));
  assert.ok(render().includes("color-purple"));
  assert.ok(!render().includes("color-green"));
  s.session.tags=[{...tags[0]!,color:"orange"}];
  assert.ok(render().includes("color-orange"));
  s.session.tags=[{...tags[0]!,name:"数据库"}];
  assert.ok(!render().includes("conversation-tag"));
  s.session.tags=[];
  assert.ok(!render().includes("conversation-tag"));
});

test("overlapping and regex-like tag names keep the displayed text and prefer the full tag", () => {
  const s=snapshot();
  s.session.tags=[...tags,{id:"mongo-long",projectId:"p",name:"MongoDB 集群",color:"blue"},{id:"cpp",projectId:"p",name:"C++",color:"orange"}];
  s.ai!.cards=[{id:"reply",type:"text",status:"completed",at,content:"MongoDB 集群与 C++：运维排查"}];
  const html=renderToStaticMarkup(createElement(AITranscript,{snapshot:s}));
  assert.ok(html.includes('color-blue" data-tag-id="mongo-long">MongoDB 集群</span>'));
  assert.ok(html.includes('color-orange" data-tag-id="cpp">C++</span>'));
  assert.ok(!html.includes('color-purple'));
});

test("sidebar uses the same colors, bounds visible tags and names the full set for accessibility", () => {
  const list=[...tags,{id:"extra",projectId:"p",name:"备份",color:"blue" as const}];
  const html=renderToStaticMarkup(createElement(SessionListTags,{tags:list}));
  assert.ok(html.includes('会话标签：MongoDB、运维排查、备份'));
  assert.ok(html.includes('color-purple') && html.includes('color-green'));
  assert.ok(!html.includes('color-blue'));
  assert.ok(html.includes('title="备份">+1</span>'));
  assert.equal(renderToStaticMarkup(createElement(SessionListTags,{tags:[]})),"");
});

test("session chrome is inline in the breadcrumb: status and a menu button replace the title and tab rows", () => {
  const session={id:"s",projectId:"p",title:"隆泰的ftp服务器在哪里",status:"completed" as const,resourceIds:[],createdAt:at,updatedAt:at,tags};
  const badge=renderToStaticMarkup(createElement(SessionStateBadge,{session}));
  assert.ok(badge.includes('class="session-state-badge state-completed"')&&badge.includes("回复结束"), "status renders inline for the breadcrumb");
  const actions=renderToStaticMarkup(createElement(SessionActions,{session,tags,disabled:false,view:"conversation",hasViews:true,onView:()=>{},onSaved:()=>{},onRefresh:async()=>{},onEdit:()=>{}}));
  assert.ok(actions.includes('aria-haspopup="menu"'), "the views and presentation edits live behind a menu");
  assert.ok(!actions.includes("session-page-header")&&!actions.includes("session-view-tabs")&&!actions.includes("role=\"tablist\""), "no title row and no tab row");
  assert.ok(!actions.includes("session-view-bar"), "no extra bar under the breadcrumb");
  assert.ok(!actions.includes("session-update-date")&&!actions.includes("更新于"), "the update date is gone from the chrome");
});

test("presentation edits stay reachable from the menu trigger without a dedicated header row", () => {
  const session={id:"s",projectId:"p",title:"T",status:"idle" as const,resourceIds:[],createdAt:at,updatedAt:at,tags};
  const html=renderToStaticMarkup(createElement(SessionActions,{session,tags,disabled:false,view:"conversation",hasViews:false,onView:()=>{},onSaved:()=>{},onRefresh:async()=>{},onEdit:()=>{}}));
  assert.ok(html.includes("session-actions-trigger"), "the menu trigger is the only chrome left");
  assert.ok(!html.includes("<h1"), "the session title is no longer duplicated in a heading");
  assert.ok(html.includes('aria-label="会话操作"'), "the trigger is labelled");
});

test("directory keeps repeated questions as separate targets and excludes unloaded turns", () => {
  const messages=[
    {id:"old",sessionId:"s",role:"user" as const,text:"较早提问",createdAt:at},
    {id:"u1",sessionId:"s",role:"user" as const,text:"现在\n状态如何",createdAt:at},
    {id:"reply",sessionId:"s",role:"assistant" as const,text:"模型回答",createdAt:at},
    {id:"u2",sessionId:"s",role:"user" as const,text:"现在 状态如何",createdAt:at},
    {id:"image",sessionId:"s",role:"user" as const,text:"",createdAt:at},
  ];
  assert.deepEqual(conversationDirectoryItems(messages,new Set(["u1","reply","u2","image"])),[
    {id:"u1",number:2,label:"现在 状态如何"},
    {id:"u2",number:3,label:"现在 状态如何"},
    {id:"image",number:4,label:"图片或附件"},
  ]);
});

test("directory turn targets exist in both dialogue and operation views and are session scoped", () => {
  const s=snapshot();
  for(const mode of ["conversation","activity"] as const) {
    const html=renderToStaticMarkup(createElement(AITranscript,{snapshot:s,mode}));
    assert.ok(html.includes(`id="${conversationTurnId("s","user")}"`));
    assert.ok(html.includes('aria-label="会话目录"') && html.includes('aria-expanded="false"'));
  }
  assert.notEqual(conversationTurnId("s/a","u1"),conversationTurnId("s","a/u1"));
});

test("the directory rail has exactly one mark per entry as history grows", () => {
  for(const count of [1,3,20]) {
    const items=Array.from({length:count},(_,index)=>({id:`u${index}`,number:index+1,label:`提问 ${index+1}`}));
    const html=renderToStaticMarkup(createElement(ConversationDirectory,{sessionId:"s",items,onJump:()=>{},onLatest:()=>{}}));
    assert.equal((html.match(/data-directory-item=/g)||[]).length,count);
    assert.equal((html.match(/is-current/g)||[]).length,1);
    assert.ok(!html.includes("<svg"));
    assert.ok(html.includes('aria-describedby='));
    assert.ok(html.includes('悬停预览这一轮的提问与回复，点击刻度跳转'));
    assert.ok(html.includes('完整记录保留'));
    assert.ok(!html.includes('title="会话目录"'), 'a native tooltip must not compete with the hover preview');
  }
});

test("active directory entry follows reading position in either scroll direction", () => {
  const positions=[{id:"start",top:0},{id:"architecture",top:500},{id:"delivery",top:1000}];
  assert.equal(activeDirectoryItem(positions,0),"start");
  assert.equal(activeDirectoryItem(positions,500),"architecture");
  assert.equal(activeDirectoryItem(positions,1400),"delivery");
  assert.equal(activeDirectoryItem(positions,100),"start");
  assert.equal(activeDirectoryItem([],0),null);
});

test("reviewed plans render only their list entry in the conversation", () => {
  const s=snapshot();
  s.conversationMode='plan';
  s.ai!.proposedPlan={id:'reply',content:'检查 MongoDB',at};
  s.ai!.cards=[{id:'reply',type:'text',status:'completed',at,content:'<proposed_plan>\n# 检查计划\n\n检查 MongoDB 8.0\n</proposed_plan>'}];
  const html=renderToStaticMarkup(createElement(AITranscript,{snapshot:s,onOpenPlans:()=>{}}));
  assert.ok(html.includes('计划已保存') && html.includes('查看计划列表'));
  assert.ok(!html.includes('检查计划') && !html.includes('MongoDB'));
  assert.ok(!html.includes('执行计划') && !html.includes('修改计划'));
  assert.ok(!html.includes('proposed_plan'));
});
