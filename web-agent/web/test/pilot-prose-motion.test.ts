import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement,type ComponentProps} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {SessionSnapshot} from '../../shared/contracts';
import {PilotSpecialistReplyView} from '../src/PilotSpecialistConversation';
import type {PilotSpecialistRow} from '../src/pilotSpecialistReplies';

const at='2026-11-16T00:00:00Z';
const prose='已收到第一段公开进度，继续核对结果。';
const activeProse=/<div class="[^"]*\bassistant-prose\b[^"]*" data-live-motion="active">/;
const stillProse=/<div class="[^"]*\bassistant-prose\b[^"]*" data-live-motion="still">/;
function progress(phase:'thinking'|'tool'='thinking'){
 const worker={id:'worker',roleId:'role',roleName:'检查专员',sessionId:'worker-session',assignmentState:'active',
  task:{taskId:'task',sessionId:'worker-session',projectId:'project',title:'隔离检查任务',state:'running' as const,acceptanceState:'not_evaluated' as const,revision:1,originRootTurnId:'task-origin',deadlineAt:at}};
 const row:PilotSpecialistRow={projectId:'project',worker,activity:{phase,label:'正在核对',updatedAt:at},sourceMessageId:'source',sourceCreatedAt:at,reportedTurns:[],
  author:{kind:'specialist',name:worker.roleName,roleId:worker.roleId,workerId:worker.id,sessionId:worker.sessionId,taskId:worker.task.taskId}};
 const snapshot={session:{id:worker.sessionId,projectId:row.projectId},superagent:{roleId:worker.roleId,task:worker.task},cursor:1,
  ai:{session:worker.sessionId,status:'running',replyStatus:'running',rootTurnId:'current-root',turnStartedAt:at,cards:[
   {id:'public',type:'message',status:'completed',at,content:prose,data:{root_turn_id:'current-root'}},
   ...(phase==='tool'?[{id:'operation',type:'operation',status:'running',at,content:'PRIVATE_TOOL_DETAIL',data:{root_turn_id:'current-root'}}]:[]),
  ],cardsOffset:0}} as SessionSnapshot;
 return {row,snapshot};
}
const render=(props:ComponentProps<typeof PilotSpecialistReplyView>)=>renderToStaticMarkup(createElement(PilotSpecialistReplyView,props));

test('received public prose keeps moving between updates throughout thinking and tool execution',()=>{
 for(const phase of ['thinking','tool'] as const){
  const props=progress(phase),html=render(props);
  assert.match(html,activeProse,phase);
  assert.match(html.replace(/<[^>]*>/g,''),new RegExp(prose));
  assert.doesNotMatch(html,/PRIVATE_TOOL_DETAIL/,'only the public progress text is exposed');
  assert.equal(render({...props,snapshot:{...props.snapshot,cursor:2}}),html,'a snapshot without new public tokens keeps the exact active prose markup');
  props.snapshot.ai!.cards[0]!.status='running';
  assert.match(render(props),activeProse,'public card streaming/completion does not substitute for the actual runtime activity');
 }
});

test('public prose stops for a real wait, terminal state, disconnection, or hidden surface',()=>{
 for(const status of ['waiting_approval','waiting_input','waiting_external','queued','completed','failed','cancelled','interrupted','paused'] as const){
  const props=progress('tool');props.snapshot.ai!.status=status;
  // A stale running reply projection must not override the authoritative wait.
  if(status==='completed')props.snapshot.ai!.replyStatus='completed';
  const html=render(props);
  assert.match(html,stillProse,status);assert.doesNotMatch(html,activeProse,status);
  assert.match(html.replace(/<[^>]*>/g,''),new RegExp(prose),'received prose remains readable');
 }
 for(const override of [{available:false},{visible:false}]){
  const html=render({...progress('tool'),...override});
  assert.match(html,stillProse);assert.doesNotMatch(html,activeProse);
 }
});
