import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement,type ComponentProps} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {SessionSnapshot} from '../../shared/contracts';
import {PilotSpecialistReplyView} from '../src/PilotSpecialistConversation';
import type {PilotSpecialistRow} from '../src/pilotSpecialistReplies';
import {SpecialistProcessLink} from '../src/SpecialistProcessLink';

const at='2026-11-16T00:00:00Z';
const prose='已收到第一段公开进度，继续核对结果。';
const processLink=(html:string)=>html.match(/<button\b[^>]*data-specialist-process="[^"]*"[\s\S]*?<\/button>/)?.[0]??'';
const assertQuietProse=(html:string,text?:string)=>{
 const body=html.match(/<div class="ai-card ai-message">([\s\S]*?)<\/div>/)?.[1]??'';
 const plain=body.replace(/<[^>]*>/g,'');
 assert.ok(plain.includes(text??prose.slice(0,-1)),'the public body stays readable');
 if(!text)assert.ok(!plain.includes(prose),'interim prose omits the closing full stop');
 assert.doesNotMatch(body,/data-live-(?:motion|glow)|live-text-motion-character/,'public prose has no continuous motion or glow hosts');
};
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
const render=(props:ComponentProps<typeof PilotSpecialistReplyView>)=>renderToStaticMarkup(createElement(PilotSpecialistReplyView,{onInspectSpecialist(){},...props}));

test('received public prose takes over from the continuous thinking and process sweep',()=>{
 for(const phase of ['thinking','tool'] as const){
  const props=progress(phase),html=render(props);
  assertQuietProse(html);
  assert.match(processLink(html),/data-live-motion="still" data-live-glow="still"/,phase);
  assert.doesNotMatch(html,/data-live-(?:motion|glow)="active"/);
  assert.doesNotMatch(html,/PRIVATE_TOOL_DETAIL/,'only the public progress text is exposed');
  assert.equal(render({...props,snapshot:{...props.snapshot,cursor:2}}),html,'unchanged snapshots retain the same body and process entry');
  props.snapshot.ai!.cards[0]!.status='running';
  assertQuietProse(render(props));
  assert.match(processLink(render(props)),/data-live-motion="still" data-live-glow="still"/);
 }
});

test('a worker completion snapshot arriving before the workspace keeps its identity during the quiet report handoff',()=>{
 const props=progress('tool');
 props.row.observedRootTurnId='current-root';
 props.snapshot.superagent!.task={...props.row.worker.task,state:'completed'};
 props.snapshot.ai!.status='completed';
 props.snapshot.ai!.replyStatus='completed';
 const html=render(props);
 assertQuietProse(html);
 assert.match(html,/<span class="response-avatar"[^>]*>[\s\S]*?data-motion="working"/);
 assert.match(processLink(html),/data-live-motion="still" data-live-glow="still"/);
 assert.doesNotMatch(html,/class="specialist-reply-cursor"/);
});

test('the process entry stops for a real wait, terminal state, disconnection, or hidden surface without removing prose',()=>{
 for(const status of ['waiting_approval','waiting_input','waiting_external','queued','completed','failed','cancelled','interrupted','paused'] as const){
  const props=progress('tool');props.snapshot.ai!.status=status;
  // A stale running reply projection must not override the authoritative wait.
  if(status==='completed'){
   props.snapshot.ai!.replyStatus='completed';
   props.row.activity.phase='updating';
   props.row.continuity='terminal';
   props.row.observedRootTurnId='current-root';
   props.row.worker.task={...props.row.worker.task,state:'completed'};
   props.snapshot.superagent!.task=props.row.worker.task;
  }
  const html=render(props);
  assertQuietProse(html);
  assert.match(processLink(html),/data-live-motion="still" data-live-glow="still"/,status);
  assert.doesNotMatch(html,/data-live-(?:motion|glow)="active"/,status);
 }
 for(const override of [{available:false},{visible:false}]){
  const html=render({...progress('tool'),...override});
  assertQuietProse(html);
  assert.match(processLink(html),/data-live-motion="still" data-live-glow="still"/);
  assert.doesNotMatch(html,/data-live-(?:motion|glow)="active"/);
 }
});

test('ACP segmented public prose keeps the exact process entry without a competing sweep',()=>{
 const props=progress('tool');
 const execution={backend:{kind:'acp' as const,agent:'codex'},source:'task_assignment' as const,assignedAt:at,runs:[{id:'acp-run',agent:'codex',scope:'worker' as const,state:'running' as const,dispatchPhase:'sent' as const,createdAt:at,updatedAt:at,usage:null}],totalRuns:1};
 props.row.worker.execution=execution;props.row.author.execution=execution.backend;props.snapshot.superagent!.execution=execution;
 props.snapshot.ai!.cards=[{id:'acp-run',type:'operation',status:'running',at,content:'PRIVATE_CUMULATIVE_AUDIT',data:{root_turn_id:'current-root',taskId:'task',source:'external_agent',external_run_id:'acp-run',external_reply:{id:'segment',content:prose}}}];
 const html=render(props);
 assertQuietProse(html);assert.doesNotMatch(html,/PRIVATE_CUMULATIVE_AUDIT/);
 assert.match(processLink(html),/data-specialist-process="task"/);
 assert.match(processLink(html),/data-live-motion="still" data-live-glow="still"/);
});

test('adopted final reports stop the process light even when a live snapshot arrives late',()=>{
 const props=progress('tool'),final='本次检查已经完成。';
 props.row.finalReport={id:'report',sessionId:'pilot',role:'assistant',text:final,createdAt:at,author:{...props.row.author,rootTurnId:'current-root'}};
 const html=render(props);
 assertQuietProse(html,final);assert.doesNotMatch(html,new RegExp(prose.slice(0,-1)));
 assert.match(processLink(html),/data-live-motion="still" data-live-glow="still"/);
 assert.doesNotMatch(html,/data-live-(?:motion|glow)="active"/);
});

test('the process link preserves native keyboard activation and exact task navigation; cold history defaults to still',()=>{
 const {row}=progress();
 const html=renderToStaticMarkup(createElement(SpecialistProcessLink,{author:row.author,onInspect(){}}));
 assert.match(processLink(html),/<button type="button"[^>]*data-specialist-process="task"[^>]*aria-controls="session-task-inspector"/);
 assert.doesNotMatch(processLink(html),/tabindex=/i);
 assert.match(processLink(html),/data-live-motion="still" data-live-glow="still"/);
 assert.equal((html.replace(/<[^>]*>/g,'').match(/执行过程/g)??[]).length,1);
 assert.doesNotMatch(html,/role="status"|aria-live=/,'the accessible process button does not add a live announcement');
});

test('a settled specialist footer uses its own recorded elapsed time',()=>{
 const {row}=progress();
 const author={...row.author,durationMs:900003};
 const html=renderToStaticMarkup(createElement(SpecialistProcessLink,{author,onInspect(){}}));
 assert.match(html,/<\/button><span class="turn-status-elapsed"[^>]*>15 分钟 0 秒<\/span>/);
 assert.match(processLink(html),/data-specialist-process="task"/);
 const channel=renderToStaticMarkup(createElement(SpecialistProcessLink,{author}));
 assert.match(channel,/用时 15\s*分钟 0\s*秒/);
 assert.doesNotMatch(channel,/<button/);
 assert.doesNotMatch(renderToStaticMarkup(createElement(SpecialistProcessLink,{author:row.author,onInspect(){}})),/用时/);
});
