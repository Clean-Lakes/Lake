import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AITranscript } from "../src/AIPanel";
import { SessionActions, SessionStateBadge } from "../src/SessionPresentation";
import { ConversationDirectory, activeDirectoryItem, conversationDirectoryItems, conversationTurnId, directoryPopoverPosition } from "../src/ConversationDirectory";
import {PilotTaskReferenceChip,pilotDirectoryTasks,pilotTaskParticipants} from "../src/PilotTaskDirectory";
import type { Message, SessionSnapshot, SuperWorker, SuperWorkspace } from "../../shared/contracts";

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

test("archived tag associations do not decorate replies or change resource references", () => {
  const s=snapshot();
  Object.assign(s.session, {tags:[{id:"ops",projectId:"p",name:"运维排查",color:"green"}]});
  s.ai!.cards=[{id:"reply",type:"message",status:"completed",at,content:[
    "## MongoDB 当前状态",
    "本次**运维排查**完成。",
    "[MongoDB 官网](https://example.com/MongoDB)",
  ].join("\n\n")}];
  const html=renderToStaticMarkup(createElement(AITranscript,{snapshot:s}));
  assert.doesNotMatch(html,/conversation-tag|data-tag-id/);
  assert.match(html,/<strong>运维排查<\/strong>/);
  assert.ok(html.includes('data-object-kind="software"') && html.includes('>MongoDB</span>'));
  assert.ok(html.includes(">MongoDB 官网</a>"));
});

test("session chrome is inline in the breadcrumb: status and a menu button replace the title and tab rows", () => {
  const session={id:"s",projectId:"p",title:"隆泰的ftp服务器在哪里",status:"completed" as const,resourceIds:[],createdAt:at,updatedAt:at};
  const badge=renderToStaticMarkup(createElement(SessionStateBadge,{session}));
  assert.ok(badge.includes('class="session-state-badge state-completed"')&&badge.includes("回复结束"), "status renders inline for the breadcrumb");
  const actions=renderToStaticMarkup(createElement(SessionActions,{session,disabled:false,view:"conversation",hasViews:true,onView:()=>{},onSaved:()=>{},onRefresh:async()=>{},onEdit:()=>{}}));
  assert.ok(actions.includes('aria-haspopup="menu"'), "the views and presentation edits live behind a menu");
  assert.ok(!actions.includes("session-page-header")&&!actions.includes("session-view-tabs")&&!actions.includes("role=\"tablist\""), "no title row and no tab row");
  assert.ok(!actions.includes("session-view-bar"), "no extra bar under the breadcrumb");
  assert.ok(!actions.includes("session-update-date")&&!actions.includes("更新于"), "the update date is gone from the chrome");
});

test("presentation edits stay reachable from the menu trigger without a dedicated header row", () => {
  const session={id:"s",projectId:"p",title:"T",status:"idle" as const,resourceIds:[],createdAt:at,updatedAt:at};
  const html=renderToStaticMarkup(createElement(SessionActions,{session,disabled:false,view:"conversation",hasViews:false,onView:()=>{},onSaved:()=>{},onRefresh:async()=>{},onEdit:()=>{}}));
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
  const s=snapshot();s.ai!.cardsOffset=1;
  for(const mode of ["conversation","activity"] as const) {
    const html=renderToStaticMarkup(createElement(AITranscript,{snapshot:s,mode}));
    assert.ok(html.includes(`id="${conversationTurnId("s","user")}"`));
    assert.ok(html.includes('aria-label="会话目录"') && html.includes('aria-expanded="false"'));
  }
  assert.notEqual(conversationTurnId("s/a","u1"),conversationTurnId("s","a/u1"));
});

test("history stays behind one directory entry point and short conversations omit it", () => {
  for(const count of [0,1,3,20]) {
    const items=Array.from({length:count},(_,index)=>({id:`u${index}`,number:index+1,label:`提问 ${index+1}`}));
    const html=renderToStaticMarkup(createElement(ConversationDirectory,{sessionId:"s",items,onJump:()=>{},onLatest:()=>{}}));
    if(count<2)assert.equal(html,'');
    else {
      assert.equal((html.match(/<button/g)||[]).length,1);
      assert.match(html,/aria-label="会话目录"/);
      assert.match(html,/aria-expanded="false"/);
      assert.doesNotMatch(html,/提问 [0-9]|conversation-directory-tick|role="dialog"/);
    }
  }
  const older=renderToStaticMarkup(createElement(ConversationDirectory,{sessionId:'s',items:[],onJump:()=>{},onLatest:()=>{},onLoadOlder:()=>{}}));
  assert.match(older,/aria-label="会话目录"/,'older records remain reachable even when no turns are currently loaded');
});

test("active directory entry follows reading position in either scroll direction", () => {
  const positions=[{id:"start",top:0},{id:"architecture",top:500},{id:"delivery",top:1000}];
  assert.equal(activeDirectoryItem(positions,0),"start");
  assert.equal(activeDirectoryItem(positions,500),"architecture");
  assert.equal(activeDirectoryItem(positions,1400),"delivery");
  assert.equal(activeDirectoryItem(positions,100),"start");
  assert.equal(activeDirectoryItem([],0),null);
});

test('the directory popover keeps its gap below the header in short windows', () => {
  assert.deepEqual(directoryPopoverPosition({left: 950, bottom: 49}, 58, {width: 1024, height: 720}),
    {left: 652, top: 70, width: 360, maxHeight: 520});
  assert.deepEqual(directoryPopoverPosition({left: 295, bottom: 78}, 58, {width: 320, height: 300}),
    {left: 12, top: 90, width: 296, maxHeight: 198});
});

test("Pilot task directory groups collaborators by public task identity and keeps same-title older tasks",()=>{
  const session={id:'pilot',projectId:'project'};
  const worker=(id:string,taskId:string,updatedAt:string):SuperWorker=>({
    id,sessionId:id,roleId:id,roleName:'运维专员',assignmentState:'parked',pilotSourceMessageId:'original',
    task:{taskId,sessionId:id,projectId:session.projectId,title:'服务器状态复测',state:'completed',
      acceptanceState:'not_evaluated',revision:1,originRootTurnId:'worker-turn',deadlineAt:at,updatedAt,summary:'专员报告'},
  });
  const old=worker('old','prior','2026-10-10T02:00:00Z');
  const first=worker('first','joint',at),second=worker('second','joint',at);
  first.pilotReport={messageId:'member-report',executionSettled:true};
  first.task.collaboration={state:'completed',acceptanceState:'not_evaluated',participants:[
    {workerId:second.id,sessionId:second.sessionId,roleId:second.roleId,roleName:second.roleName,state:'completed',contributed:true},
  ]};
  const repeated={...worker('repeat','joint',at),roleId:first.roleId};
  const foreign=worker('foreign','joint',at);
  foreign.task.projectId='other';
  const workspace:SuperWorkspace={active:true,project:{projectId:session.projectId,routerSessionId:session.id,version:1},
    workers:[first,old,second,repeated,foreign,{...worker('child','joint',at),parentWorkerId:first.id}]};
  const messages:Message[]=[
    {id:'original',sessionId:session.id,role:'user',text:'检查主机',createdAt:at},
    {id:'member-report',sessionId:session.id,role:'assistant',text:'节点状态正常。',createdAt:at,
      author:{kind:'specialist',name:first.roleName,workerId:first.id,roleId:first.roleId,sessionId:first.sessionId,taskId:'joint'}},
    {id:'joint-report',sessionId:session.id,role:'assistant',text:'两位专员已提交报告。',createdAt:at,jointReport:{taskId:'joint',reportId:'joint'}},
    {id:'conclusion',sessionId:session.id,role:'assistant',text:'主机可达，查询还待验证。',createdAt:at,jointReport:{taskId:'joint',reportId:'joint',kind:'summary'}},
  ];
  const tasks=pilotDirectoryTasks({workspace,session,messages,resources:[]});
  assert.deepEqual(tasks.map(task=>task.taskId),['joint','prior']);
  assert.equal(tasks[0]?.summary,'主机可达，查询还待验证。');
  assert.equal(tasks[0]?.reports,1);
  assert.equal(tasks[0]?.sourceMessageId,'original');
  const members=pilotTaskParticipants(workspace,session,'joint');
  assert.deepEqual(members,tasks[0]?.members);
  assert.deepEqual(members.map(member=>member.roleId),['first','second'],'deduplicates roles within the exact task');
  assert.deepEqual(pilotTaskParticipants(workspace,session,'prior').map(member=>member.roleId),['old'],'keeps same-title tasks separate');
  assert.deepEqual(pilotTaskParticipants(workspace,{...session,id:'other-pilot'},'joint'),[]);
  const chip=renderToStaticMarkup(createElement(PilotTaskReferenceChip,{task:tasks[0]!,members,compact:true,onClear:()=>{}}));
  assert.match(chip,/data-role-id="first".*data-role-id="second"/);
  assert.match(chip,/aria-label="移除任务续接"/);
  assert.deepEqual(pilotDirectoryTasks({workspace,session:{...session,id:'other-pilot'},messages,resources:[]}),[]);
  const html=renderToStaticMarkup(createElement(ConversationDirectory,{sessionId:session.id,items:[],onJump:()=>{},onLatest:()=>{},
    taskDirectory:{workspace,session,messages,resources:[],onContinue:()=>{}}}));
  assert.match(html,/aria-label="会话目录"/);
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
