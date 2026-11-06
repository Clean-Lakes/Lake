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
