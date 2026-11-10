import {registerHooks} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import assert from 'node:assert/strict';
import test from 'node:test';
import type {AgentExecutionSummary,ExternalAgentRunSummary} from '../../shared/external-agents';
import {agentExecutionPresentation,externalRunPresentation} from '../src/agentExecutionState';

const css=registerHooks({load(url,context,nextLoad){return url.endsWith('.css')?{format:'module',source:'export {};',shortCircuit:true}:nextLoad(url,context)}});
const {AgentExecution}=await import('../src/AgentExecution');
const {SpecialistChannelEntries}=await import('../src/SpecialistChannel');
css.deregister();

const execution:AgentExecutionSummary={backend:{kind:'acp',agent:'codex',revision:2},source:'task_assignment',assignedAt:'2026-11-10T01:00:00Z',runs:[],totalRuns:0};
const run:ExternalAgentRunSummary={id:'actual-run',agent:'codex',scope:'worker',state:'running',dispatchPhase:'sent',externalSessionId:'actual-session',createdAt:execution.assignedAt,updatedAt:execution.assignedAt,usage:null};
test('a selected Codex executor without an actual run is never shown as called or complete',()=>{
 assert.equal(agentExecutionPresentation(execution).label,'Codex 尚未派发');
 const html=renderToStaticMarkup(createElement(AgentExecution,{execution,roleName:'数据库专员'}));
 assert.match(html,/数据库专员/);assert.match(html,/任务 Worker/);assert.match(html,/Codex/);assert.match(html,/尚无外部执行记录/);
 assert.doesNotMatch(html,/已回传|任务已完成|验收通过|actual-run/);
});
test('actual dispatch stages, approvals, return and unknown results remain distinct',()=>{
 assert.equal(externalRunPresentation({...run,state:'starting',dispatchPhase:'not_sent'}).label,'正在连接 Codex');
 assert.equal(externalRunPresentation(run).label,'Codex 执行中');
 assert.equal(externalRunPresentation(run,true).label,'Codex 等待确认');
 assert.equal(externalRunPresentation({...run,state:'completed',dispatchPhase:'answered'}).label,'Codex 已回传');
 assert.equal(externalRunPresentation({...run,state:'unknown'}).label,'Codex 结果待核实');
});
test('the actual external report is collected with its identity without fabricating usage or task acceptance',()=>{
 const html=renderToStaticMarkup(createElement(AgentExecution,{execution:{...execution,runs:[{...run,state:'completed',summary:'ACTUAL_CODEX_REPORT <script>unsafe()</script>'}],totalRuns:1}}));
 assert.match(html,/data-run-id="actual-run"/);assert.match(html,/ACTUAL_CODEX_REPORT/);assert.match(html,/外部用量未报告/);assert.match(html,/任务按工具回执验收/);
 assert.doesNotMatch(html,/<script>|验收通过|任务已完成/);
});
test('native Worker delegation still reveals the actual external segment without relabeling the Worker',()=>{
 const html=renderToStaticMarkup(createElement(AgentExecution,{execution:{...execution,backend:{kind:'native'},runs:[{...run,scope:'segment'}],totalRuns:1}}));
 assert.match(html,/data-execution-agent="native"/);assert.match(html,/Lake Worker/);assert.match(html,/受委派执行/);assert.match(html,/Codex 执行中/);
});
test('specialist channel renders the frozen task executor and collected report alongside its real reply',()=>{
 const worker={id:'worker',roleId:'role',roleName:'项目专员',sessionId:'worker-session',assignmentState:'parked',task:{taskId:'task',title:'检查工作区',state:'paused'},execution:{...execution,runs:[{...run,state:'failed',error:'认证未通过'}],totalRuns:1}};
 const entry={id:'reply',sourceSessionId:'worker-session',taskId:'task',workerId:'worker',createdAt:run.createdAt,message:{id:'report',role:'assistant',text:'请先检查连接配置。',createdAt:run.createdAt}};
 const html=renderToStaticMarkup(createElement(SpecialistChannelEntries,{entries:[entry],workers:[worker],resources:[],connected:true} as never));
 assert.match(html,/Agent 分配与回传/);assert.match(html,/Codex 执行失败/);assert.match(html,/认证未通过/);assert.match(html,/请先检查连接配置/);
});
