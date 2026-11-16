import assert from 'node:assert/strict';
import test from 'node:test';
import {registerHooks} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {AICard,SessionSnapshot} from '../../shared/contracts';
import {workerProcessRecords} from '../src/workerProcessRecords';

const css=registerHooks({load(url,context,nextLoad){return url.endsWith('.css')?{format:'module',source:'export {};',shortCircuit:true}:nextLoad(url,context)}});
const {WorkerExecutionTree,WorkerExecutionResults}=await import('../src/WorkerExecutionTree');
css.deregister();
const at='2026-11-16T00:00:00Z';
const card=(id:string,type='message',root='sdk-first',extra:Record<string,unknown>={}):AICard=>({id,type,content:id,status:'completed',at,data:{taskId:'execution-task',root_turn_id:root,...extra}});
function snapshot(cards:AICard[]):SessionSnapshot{
 return {session:{id:'worker-session',projectId:'project',workspaceRole:'worker'},superagent:{task:{taskId:'canonical-task',executionGoalId:'execution-task',sessionId:'worker-session',projectId:'project',originRootTurnId:'task-origin',state:'completed',summary:'FINAL_REPORT'},execution:{backend:{kind:'native'},source:'task_assignment',assignedAt:at,runs:[],totalRuns:0}},
  resources:[],ai:{session:'worker-session',status:'completed',rootTurnId:'task-origin',cards,agentRuns:[]}} as unknown as SessionSnapshot;
}
const ids=(value:SessionSnapshot)=>workerProcessRecords(value).map(card=>card.id);

test('task audit retains saved native thinking and reply records from every actual SDK invocation',()=>{
 const records=[card('FIRST_THOUGHT','thinking'),card('FIRST_PROGRESS'),card('SECOND_THOUGHT','thinking','sdk-second'),card('FINAL_REPORT','message','sdk-second')];
 const value=snapshot(records),before=JSON.stringify(value);
 assert.deepEqual(ids(value),records.map(card=>card.id));
 assert.equal(JSON.stringify(value),before,'audit projection never changes the current public reply or original records');
 for(const state of ['running','waiting_user','completed','failed','cancelled','paused'] as const){
  value.superagent!.task.state=state;
  assert.deepEqual(ids(value),records.map(card=>card.id),'completion does not discard saved process history');
 }
});

test('an untagged legacy record needs an actual parent task root; origin and child roots are not current-root proof',()=>{
 const value=snapshot([
  card('host-call','operation'),
  card('LEGACY_PROSE','message','sdk-first',{taskId:undefined}),
  card('FOREIGN_TASK','message','sdk-first',{taskId:'other-task'}),
  card('FOREIGN_ROOT','message','unrelated-sdk',{taskId:undefined}),
  card('ORIGIN_ONLY','message','task-origin',{taskId:undefined}),
  card('CHILD_THOUGHT','thinking','sdk-child',{agentRunId:'child'}),
  card('CHILD_PROSE','message','sdk-child',{childSessionId:'child-session'}),
  card('UNPROVEN_CHILD_ROOT','message','sdk-child',{taskId:undefined}),
  card('CANONICAL_ID_IS_NOT_EXECUTION_ID','message','sdk-first',{taskId:'canonical-task'}),
 ]);
 assert.deepEqual(ids(value),['LEGACY_PROSE']);
});

test('missing or foreign task ownership never exposes process records from the snapshot',()=>{
 const value=snapshot([card('OWN_PROSE')]);
 assert.deepEqual(ids({...value,superagent:undefined}),[]);
 assert.deepEqual(ids({...value,superagent:{...value.superagent!,task:{...value.superagent!.task,sessionId:'other-session'}}}),[]);
 assert.deepEqual(ids({...value,superagent:{...value.superagent!,task:{...value.superagent!.task,projectId:'other-project'}}}),[]);
 assert.deepEqual(ids({...value,ai:{...value.ai!,cards:[card('UNBOUND','message','',{taskId:undefined})]}}),[]);
});

test('ACP audit stays in its accumulated operation record and never becomes duplicate native prose',()=>{
 const operation={...card('acp-run','operation','acp-root',{source:'external_agent',external_run_id:'acp-run',external_reply:{id:'last-segment',content:'ACP_LAST_SEGMENT'}}),content:'ACP_FIRST_SEGMENT\nACP_LAST_SEGMENT'};
 const completed=card('ACP_COMPLETED_MESSAGE','message','acp-root');
 const value=snapshot([operation,completed]);
 value.superagent!.execution={...value.superagent!.execution!,backend:{kind:'acp',agent:'codex'},runs:[]};
 assert.deepEqual(ids(value),[]);
 const html=renderToStaticMarkup(createElement(WorkerExecutionTree,{snapshot:value}));
 assert.doesNotMatch(html,/worker-process-records|ACP_COMPLETED_MESSAGE/);
 assert.match(html,/ACP_FIRST_SEGMENT\nACP_LAST_SEGMENT/);
 assert.equal((html.match(/ACP_FIRST_SEGMENT/g)??[]).length,1);
 assert.equal(operation.content,'ACP_FIRST_SEGMENT\nACP_LAST_SEGMENT');
});

test('legacy mixed execution snapshots preserve native roots without duplicating ACP or borrowing child execution',()=>{
 const value=snapshot([
  card('acp-run','operation','acp-root',{source:'external_agent',external_run_id:'acp-run'}),
  card('ACP_COMPLETED_MESSAGE','message','acp-root'),
  card('NATIVE_PROGRESS','message','native-root'),
  card('CHILD_ACP_OPERATION','operation','native-root',{source:'external_agent',agentRunId:'child',childSessionId:'child-session'}),
  card('EXTERNAL_MARKED_MESSAGE','message','native-root',{source:'external_agent'}),
 ]);
 value.superagent!.execution=undefined;
 assert.deepEqual(ids(value),['NATIVE_PROGRESS']);
});

test('empty and repeated transport cards do not create duplicate audit paragraphs',()=>{
 const before=card('same');before.content='PREFIX';
 const after={...before,content:'PREFIX APPENDED'};
 const empty={...card('empty'),content:' \n '};
 assert.deepEqual(workerProcessRecords(snapshot([before,empty,after])).map(card=>card.content),['PREFIX APPENDED']);
});

test('native audit is folded and separate from the public task summary, even without a work goal',()=>{
 const value=snapshot([card('THINKING_RECORD','thinking'),card('PROGRESS_RECORD'),card('FINAL_REPORT')]);
 assert.equal(value.superagent!.goal,undefined);
 const html=renderToStaticMarkup(createElement(WorkerExecutionTree,{snapshot:value}));
 const start=html.indexOf('<details class="worker-execution-branch worker-process-records"');
 const end=html.indexOf('</details>',start);
 assert.ok(start>=0&&end>start);
 const folded=html.slice(start,end);
 assert.doesNotMatch(folded.slice(0,folded.indexOf('>')),/\bopen/);
 for(const text of ['THINKING_RECORD','PROGRESS_RECORD','FINAL_REPORT'])assert.ok(folded.includes(text));
 assert.match(folded,/思考记录/);assert.match(folded,/公开回复记录/);
 assert.doesNotMatch(html.slice(0,start)+html.slice(end),/THINKING_RECORD|PROGRESS_RECORD|FINAL_REPORT/);
 const result=renderToStaticMarkup(createElement(WorkerExecutionResults,{snapshot:value}));
 assert.equal((result.match(/FINAL_REPORT/g)??[]).length,1);
 assert.doesNotMatch(result,/THINKING_RECORD|PROGRESS_RECORD/);
});

test('saved process Markdown remains readable without executing markup or fetching remote images',()=>{
 const saved={...card('markdown'),content:'查看 [原始链接](https://example.test/report)。\n\n<script>unsafe()</script>\n\n![图片说明](https://example.test/tracker.png)\n\n`原始内容`'};
 const html=renderToStaticMarkup(createElement(WorkerExecutionTree,{snapshot:snapshot([saved])}));
 assert.match(html,/<a href="https:\/\/example.test\/report"/);assert.match(html,/<code>原始内容<\/code>/);
 assert.match(html,/图片说明/);assert.doesNotMatch(html,/<script|<img|tracker\.png|data-live-motion/);
});
