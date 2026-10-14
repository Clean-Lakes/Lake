import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentRun, SessionSnapshot } from "../../shared/contracts";
import { AgentTaskList } from "../src/AgentTaskList";
import { AgentIcon } from "../src/AgentIcon";
import { AITranscript } from "../src/AIPanel";
import { agentDuration, agentGroupLabel, agentIdentity, transcriptAgentRuns } from "../src/agentTasks";
import { orderedTranscript, transcriptGroups, transcriptTurns } from "../src/timeline";

const at="2026-10-12T03:00:00Z";
const run=(overrides:Partial<AgentRun>={}):AgentRun=>({id:"run",sessionId:"s",rootTurnId:"turn",role:"host",task:"检查主机指标",resourceIds:["host-a"],status:"running",createdAt:at,startedAt:at,canCancel:true,...overrides});
const snapshot=(runs:AgentRun[]=[]):SessionSnapshot=>({session:{id:"s"},messages:[{id:"u",role:"user",text:"排查主机",createdAt:at}],resources:[{id:"host-a",name:"生产主机 A"},{id:"host-b",name:"生产主机 B"}],specialists:[],evidence:[],actions:[],ai:{session:"s",status:"running",rootTurnId:"turn",profile:"core",cards:[],agentRuns:runs,cardsOffset:0,startedAt:at,turnStartedAt:at}} as SessionSnapshot);

test("only actual independent tasks create agents; ordinary tool cards remain Lake operations",()=>{
  const s=snapshot();s.ai!.cards=[{id:"tool",type:"operation",title:"inspect_host",status:"running",at}];
  assert.deepEqual(transcriptAgentRuns(s),[]);
  const html=renderToStaticMarkup(createElement(AITranscript,{snapshot:s}));
  assert.ok(html.includes("检查主机状态"));assert.ok(!html.includes("Scout"));assert.ok(!html.includes("agent-task-list"));
});
test("names have distinct stable role shapes, including the eight planned roles",()=>{
  const expected={host:"Scout",application:"Trace",data:"Deep",network:"Link",change:"Delta",verify:"Beacon",plan:"Pilot",memory:"Scribe"};
  const shapes=new Set<string>();
  for(const [role,name] of Object.entries(expected)){const identity=agentIdentity({role});assert.equal(identity.name,name);shapes.add(renderToStaticMarkup(createElement(AgentIcon,{role:identity.icon})));}
  assert.equal(shapes.size,8);assert.equal(agentIdentity({role:"unrecognized",name:"Existing specialist"}).name,"Existing specialist");
});
test("parallel instances retain resource names, status labels, details and actual evidence",()=>{
  const runs=[run({id:"a",status:"completed",finishedAt:"2026-10-12T03:00:09Z",summary:"主机资源充足",evidenceIds:["ev"]}),run({id:"b",resourceIds:["host-b"]})];
  const s=snapshot(runs);s.evidence=[{id:"ev",sessionId:"s",specialistId:null,resourceId:"host-a",title:"指标快照",excerpt:"CPU idle 99%",command:null,exitCode:0,collectedAt:at}];
  const html=renderToStaticMarkup(createElement(AgentTaskList,{runs,resources:s.resources,evidence:s.evidence,live:true,onCancelRun:async()=>{},onStopTurn:()=>{}}));
  for(const text of ["生产主机 A","生产主机 B","已完成","执行中","1 / 2 已完成","CPU idle 99%","9秒","停止 Scout","停止本轮"]){assert.ok(html.includes(text),text);}
  assert.equal((html.match(/停止 Scout/g)||[]).length,1);
  assert.ok(!html.includes('opacity:'));
});
test("stopped, failed, queued and unknown tasks never count as completed",()=>{
  const statuses=["cancelled","failed","queued","unknown"] as const;
  const runs=statuses.map((status,i)=>run({id:String(i),status,canCancel:false}));
  const html=renderToStaticMarkup(createElement(AgentTaskList,{runs,resources:[],live:false,onCancelRun:async()=>{},onStopTurn:()=>{}}));
  assert.ok(html.includes("0 / 4 已完成"));for(const label of ["已停止","执行失败","排队中","状态待核查"]){assert.ok(html.includes(label));}
  assert.ok(!html.includes("停止 Scout"));assert.ok(!html.includes("停止本轮"));assert.equal(agentGroupLabel(runs,true),"部分结果待核查");
  assert.equal(agentDuration(run({status:"queued",startedAt:undefined}),Date.now()),"尚未开始");
  assert.equal(agentDuration(run({status:"interrupted"}),Date.now()),"未记录");
});
test("foreign tasks are excluded and actual runtime rows take precedence over legacy rows",()=>{
  const s=snapshot([run(),run({id:"foreign",sessionId:"other"})]);
  s.specialists=[{id:"run",sessionId:"s",name:"logs",task:"old",status:"working",createdAt:at,finishedAt:null,summary:null},{id:"legacy",sessionId:"s",name:"logs",task:"real old investigation",status:"completed",createdAt:at,finishedAt:at,summary:"recorded"}];
  const rows=transcriptAgentRuns(s);assert.deepEqual(rows.map(r=>r.id),["legacy","run"]);assert.equal(rows[0]!.role,"application");assert.equal(rows[0]!.canCancel,false);
});
test("agent runs stay in their original user turn, while unverified candidates remain private",()=>{
  const s=snapshot([run({id:"old"}),run({id:"new",rootTurnId:"next",createdAt:"2026-10-12T03:00:05Z"})]);
  s.messages.push({id:"next-user",sessionId:"s",role:"user",text:"继续",createdAt:"2026-10-12T03:00:04Z"});
  const entries=orderedTranscript(s,[{id:"draft",type:"draft",status:"completed",content:"UNVERIFIED_CANDIDATE",at:"2026-10-12T03:00:06Z"}],0);
  assert.deepEqual(transcriptTurns(entries).map(turn=>turn.map(entry=>entry.id)),[["u","agent:old"],["next-user","agent:new"]]);
  assert.ok(!entries.some(entry=>entry.id==="draft"));assert.equal(transcriptGroups(entries).length,4);
});
test("child details stay collapsed while one turn footer owns live progress",()=>{
  const s=snapshot([run(),run({id:"trace",role:"application"})]);
  s.ai!.cards=[{id:"thinking",type:"thinking",status:"running",content:"RAW_PRIVATE_REASONING",at}];
  const html=renderToStaticMarkup(createElement(AITranscript,{snapshot:s}));
  assert.equal((html.match(/2 个子任务执行中…/g)||[]).length,1);
  assert.ok(!html.includes("ai-progress-activity"));assert.ok(!html.includes("RAW_PRIVATE_REASONING"));
});
test("runtime evidence is readable and evidence belonging to another session is excluded",()=>{
  const r=run({evidenceIds:["owned","foreign"],evidence:[{id:"owned",sessionId:"s",runId:"run",resourceId:"host-a",title:"真实观察",excerpt:"OWNED_EVIDENCE",exitCode:0,collectedAt:at},{id:"foreign",sessionId:"other",runId:"run",resourceId:"host-a",title:"foreign",excerpt:"FOREIGN_EVIDENCE",exitCode:0,collectedAt:at}]});
  const html=renderToStaticMarkup(createElement(AgentTaskList,{runs:[r],resources:[]}));
  assert.ok(html.includes("OWNED_EVIDENCE"));assert.ok(!html.includes("FOREIGN_EVIDENCE"));assert.ok(html.includes("1 项"));
});
