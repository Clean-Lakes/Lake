import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {AICard} from '../../shared/contracts';
import {externalTimelineSteps,specialistTimeline} from '../../shared/specialist-timeline';
import {TaskReplyTimeline} from '../src/TaskReplyTimeline';

const start='2026-01-01T00:00:00Z',first='2026-01-01T00:00:18Z',later='2026-01-01T00:01:42Z';
test('Codex tool updates retain first timestamp and identity without exposing commands',()=>{
 const steps=externalTimelineSteps([
  {kind:'tool',callId:'a',toolKind:'commandExecution',title:'some private command --argument',at:first,status:'running'},
  {kind:'tool',callId:'b',toolKind:'mcpToolCall',title:'redis / list_streams',at:later,status:'running'},
  {kind:'tool_update',callId:'a',at:later,status:'failed'},
 ]);
 assert.deepEqual(steps,[{id:'a',at:first,label:'执行命令',status:'failed'},{id:'b',at:later,label:'redis / list_streams',status:'running'}]);
});

test('only the exact worker invocation contributes rows to the chat and frozen report',()=>{
 const card:AICard={id:'a',at:first,type:'operation',title:'inspect_host',status:'completed',data:{taskId:'task',root_turn_id:'root'}};
 const cards=[card,...[{root_turn_id:'old'},{taskId:'other'},{childSessionId:'child'},{agentRunId:'child'}].map((change,index)=>({...card,id:String(index),data:{taskId:'task',root_turn_id:'root',...change}}))];
 const timeline=specialistTimeline({rootTurnId:'root',turnStartedAt:start,cards},'task','root');
 assert.deepEqual(timeline?.steps,[{id:'a',at:first,label:'检查主机状态',status:'completed'}]);
 assert.equal(specialistTimeline({cards},'task',undefined),undefined);
 const html=renderToStaticMarkup(createElement(TaskReplyTimeline,{timeline,reportAt:later,children:'巡检仍未恢复。'}));
 assert.match(html,/00:18/);assert.match(html,/01:42/);assert.match(html,/巡检仍未恢复/);
 assert.ok(html.indexOf('检查主机状态')<html.indexOf('巡检仍未恢复'));
});
