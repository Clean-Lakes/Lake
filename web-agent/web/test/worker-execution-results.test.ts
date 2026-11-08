import {registerHooks} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import assert from 'node:assert/strict';
import test from 'node:test';
import type {AICard,SessionSnapshot} from '../../shared/contracts';

// Browser-only stylesheet loading is irrelevant to the rendered record set.
const css=registerHooks({load(url,context,nextLoad){return url.endsWith('.css')?{format:'module',source:'export {};',shortCircuit:true}:nextLoad(url,context)}});
const {WorkerExecutionResults,WorkerExecutionTree}=await import('../src/WorkerExecutionTree');
css.deregister();

test('execution tree renders resources at the top and retains task-level records',()=>{
 const card=(id:string,resourceId?:string):AICard=>({id,title:id,type:'operation',content:'记录内容',at:'2026-11-06T00:00:00Z',status:'completed',data:{taskId:'task',...(resourceId?{resource_id:resourceId}:{})}});
 const snapshot={session:{id:'session',projectId:'project'},resources:[{id:'a',name:'目标服务器',projectId:'project',kind:'ssh'}],resourceTree:[{id:'folder',name:'生产目录',projectId:'project',kind:'folder',parentId:null,position:0},{id:'leaf',projectId:'project',kind:'resource',resourceId:'a',parentId:'folder',position:0}],superagent:{task:{taskId:'task',sessionId:'session',state:'completed'}},ai:{cards:[card('资源操作','a'),card('任务操作')],agentRuns:[]}} as unknown as SessionSnapshot;
 const html=renderToStaticMarkup(createElement(WorkerExecutionTree,{snapshot}));
 assert.match(html,/目标服务器/);
 assert.match(html,/资源操作/);
 assert.match(html,/任务操作/);
 assert.doesNotMatch(html,/生产目录/);
});

test('results render only canonical business receipts and preserve failure and unknown states',()=>{
 const card=(id:string,title:string,status='completed',operationId?:string):AICard=>({id,title,type:'operation',content:'fixture payload',at:'2026-11-06T00:00:00Z',status,data:{taskId:'task',...(operationId?{operation_id:operationId}:{})}});
 const snapshot={session:{id:'session',projectId:'project'},resources:[],superagent:{task:{taskId:'task',sessionId:'session',summary:'实际业务结果'}},ai:{cards:[
  card('begin','work_begin'),card('finish','work_finish'),card('assets','list_assets'),card('mcp','list_mcp_servers'),card('unproven','没有账本的旧读取'),
  card('success','真实业务读取','completed','receipt-read'),card('failed','实际失败调用','failed','receipt-failed'),card('unknown','待核实调用','unknown','receipt-unknown'),
 ]}} as unknown as SessionSnapshot;
 const html=renderToStaticMarkup(createElement(WorkerExecutionResults,{snapshot}));
 assert.match(html,/业务工具回执.*?<small>3 项<\/small>/s);
 assert.match(html,/真实业务读取/);assert.match(html,/step-failed/);assert.match(html,/step-unknown/);
 assert.doesNotMatch(html,/work_begin|work_finish|list_assets|list_mcp_servers|没有账本的旧读取/);
});

test('task results render readable Markdown without executing HTML or loading external images',()=>{
 const summary='找到[安全目录](https://example.test/security)。\n\n- [检查记录](https://example.test/report)：保留完整结论。\n- 未验证部分使用 `待核实`。\n\n| 项目 | 结果 |\n| --- | --- |\n| 样本 | 一致 |\n\n<script>alert(1)</script>\n\n[危险链接](javascript:alert(1))\n\n![附件说明](https://example.test/tracker.png)';
 const snapshot={session:{id:'session',projectId:'project'},resources:[],superagent:{task:{taskId:'task',sessionId:'session',summary}},ai:{cards:[]}} as unknown as SessionSnapshot;
 const html=renderToStaticMarkup(createElement(WorkerExecutionResults,{snapshot}));
 assert.match(html,/<a href="https:\/\/example.test\/security"[^>]*>安全目录<\/a>/);
 assert.match(html,/<li><a href="https:\/\/example.test\/report"[^>]*>检查记录<\/a>/);
 assert.match(html,/<table>/);assert.match(html,/<code>待核实<\/code>/);
 assert.doesNotMatch(html,/\[安全目录\]|javascript:|<script|<img|tracker\.png/);
 assert.match(html,/附件说明/);assert.match(html,/暂无关联的业务工具回执/);
 assert.doesNotMatch(html,/业务工具回执<\/span>/);
 assert.equal(snapshot.superagent!.task!.summary,summary);
});

test('overview shows one canonical verdict and never infers acceptance from report text',async()=>{
 const {SuperTaskInspector}=await import('../src/SuperTaskInspector');
 const task={taskId:'task',sessionId:'worker',title:'核对数据',state:'completed',acceptanceState:'pass',summary:'报告声称完成',updatedAt:'2026-11-08T02:00:00Z'} as any;
 const goal={id:'task',items:[]} as any;
 const html=renderToStaticMarkup(createElement(SuperTaskInspector,{task,goal,summaryOnly:true}));
 assert.equal((html.match(/已验收/g)??[]).length,1);
 assert.doesNotMatch(html,/验收通过|报告声称完成/);
 assert.match(html,/<time[^>]*dateTime="2026-11-08T02:00:00Z"/);
 const pending=renderToStaticMarkup(createElement(SuperTaskInspector,{task:{...task,acceptanceState:'insufficient'},goal,summaryOnly:true}));
 assert.match(pending,/待验收/);assert.match(pending,/验收证据不足/);assert.doesNotMatch(pending,/已验收|验收通过/);
 const failed=renderToStaticMarkup(createElement(SuperTaskInspector,{task:{...task,state:'failed',acceptanceState:'not_evaluated'},goal,summaryOnly:true}));
 assert.match(failed,/执行失败/);assert.doesNotMatch(failed,/已验收|验收通过/);
});

test('result view folds step history and omits an empty plan placeholder',async()=>{
 const {SuperTaskInspector}=await import('../src/SuperTaskInspector');
 const task={taskId:'task',sessionId:'worker',state:'completed',acceptanceState:'pass'} as any;
 const goal={id:'task',items:[{id:'step',title:'核对样本',status:'completed'}]} as any;
 const render=(goal:any)=>renderToStaticMarkup(createElement(SuperTaskInspector,{task,goal,plan:true,hideHeading:true,foldSteps:true}));
 const html=render(goal);
 assert.match(html,/<details class="super-task-step-records"><summary/);
 assert.match(html,/执行步骤/);assert.match(html,/核对样本/);
 assert.doesNotMatch(render({...goal,items:[]}),/计划生成后|执行步骤/);
});


test('task execution mounts Mini Box immediately for host-owned Bash and inspect_host including child calls',()=>{
 const card=(id:string,title:string,resource='a'):AICard=>({id,title,type:'operation',status:'running',at:'2026-11-06T00:00:00Z',data:{taskId:'task',resource_id:resource,operation_id:id,arguments:{command:'printf MINI_FIRST'}}});
 const snapshot={session:{id:'session',projectId:'project',createdAt:'2026-11-06T00:00:00Z'},terminals:[],resources:[{id:'a',name:'本机',projectId:'project',kind:'local'},{id:'b',name:'远端',projectId:'project',kind:'ssh'}],superagent:{task:{taskId:'task',sessionId:'session',state:'running'}},ai:{cards:[card('parent','Bash')],agentRuns:[{id:'child',source:'native_subagent',sessionId:'session',taskId:'task',childSessionId:'sdk-child',name:'原生子执行',status:'running',createdAt:'2026-11-06T00:00:00Z',resourceIds:['b'],cards:[card('child-call','inspect_host','b')]}]}} as unknown as SessionSnapshot;
 const html=renderToStaticMarkup(createElement(WorkerExecutionTree,{snapshot,connected:true}));
 assert.match(html,/Mini Box 本机 命令终端/);assert.match(html,/Mini Box SSH 命令终端/);
 assert.equal((html.match(/class="mini-box is-operating is-collapsed"/g)??[]).length,2);
 assert.match(html,/MINI_FIRST/);assert.match(html,/原始执行记录/);
 assert.doesNotMatch(renderToStaticMarkup(createElement(WorkerExecutionTree,{snapshot:{...snapshot,ai:{...snapshot.ai!,cards:[{...card('foreign','Bash'),data:{taskId:'other',resource_id:'a'}}],agentRuns:[]}}})),/Mini Box/);
});

test('a parked specialist shows separate outcomes for its original and verification attempts',async()=>{
 const {SuperTaskInspector}=await import('../src/SuperTaskInspector');
 const task={sessionId:'worker',taskId:'goal',state:'blocked',acceptanceState:'not_evaluated'} as any;
 const goal={id:'goal',items:[{id:'inspect',title:'验证探针',status:'blocked',attempts:[
  {id:'prior',status:'unknown',createdAt:'2026-11-07T01:00:00Z'},
  {id:'followup',status:'blocked',createdAt:'2026-11-07T01:01:00Z'}]}]} as any;
 const html=renderToStaticMarkup(createElement(SuperTaskInspector,{task,goal,plan:true,hideHeading:true}));
 assert.match(html,/2 次执行/);
 assert.match(html,/结果待核实/);
 assert.match(html,/data-state="blocked"/);
 assert.doesNotMatch(html,/执行中|执行成功/);
});
