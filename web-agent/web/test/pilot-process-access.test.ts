import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {Message,SessionSnapshot,SpecialistConversation,SuperWorkspace} from '../../shared/contracts';
import {AITranscript} from '../src/AIPanel';
import {PilotSpecialistReplyView} from '../src/PilotSpecialistConversation';
import {pilotDispatchRows} from '../src/pilotSpecialistReplies';
import {SpecialistProcessLink} from '../src/SpecialistProcessLink';
import {SessionInspectorProvider} from '../src/SessionInspectorContext';

const at='2026-11-16T00:00:00Z';
const user:Message={id:'human',sessionId:'pilot',role:'user',text:'核对样例',createdAt:at};
const round:SpecialistConversation={id:'round',projectId:'project',sessionId:'pilot',sourceMessageId:user.id,title:'召集核对',state:'completed',createdAt:at,deadlineAt:at,members:[{id:'member',roleId:'role',roleName:'检查专员',sessionId:'speaker',state:'replied'}]};
const workspace:SuperWorkspace={active:true,project:{projectId:'project',routerSessionId:'pilot',version:1},workers:[],conversations:[round]};
function pilot(status='completed'):SessionSnapshot{
 return {session:{id:'pilot',projectId:'project',workspaceRole:'router'},messages:[user],resources:[],actions:[],ai:{session:'pilot',status,turnStartedAt:at,cards:[{id:'think',type:'thinking',status:status==='running'?'running':'completed',at,content:'已保存的 Pilot 思考记录'}],cardsOffset:0}} as SessionSnapshot;
}
const markup=(snapshot:SessionSnapshot)=>renderToStaticMarkup(createElement(AITranscript,{snapshot,pilotWorkspace:workspace,assistantIdentity:{name:'Pilot',pilot:true}}));

test('completed specialist consultation keeps the Pilot process entry when recorded thinking exists',()=>{
 const html=markup(pilot());
 assert.match(html,/turn-duration-disclosure/);
 assert.match(html,/执行过程/);
 assert.match(html,/aria-label="思考与操作过程"/);
 const empty=pilot();empty.ai!.cards=[];
 assert.doesNotMatch(markup(empty),/turn-duration-disclosure/,'an empty completed consultation needs no synthetic record');
});

test('a Pilot router with its own persistent task can inspect the dispatch for this user turn',()=>{
 const snapshot=pilot();
 snapshot.superagent={roleId:'pilot:project',task:{taskId:'router-main',sessionId:'pilot',projectId:'project',title:'Pilot',state:'running',acceptanceState:'not_evaluated',revision:1,originRootTurnId:'router-root',deadlineAt:at}};
 snapshot.ai!.cards=[{id:'dispatch-for-this-turn',type:'operation',title:'route_work',status:'completed',at,data:{source_message_id:user.id}}];
 const html=markup(snapshot);
 const details=html.slice(html.indexOf('aria-label="执行详细过程"'));
 assert.match(details,/data-conversation-entry="dispatch-for-this-turn"/);
 assert.match(details,/class="thinking-toggle"/);
 assert.doesNotMatch(html.slice(0,html.indexOf('aria-label="执行详细过程"')),/data-conversation-entry="dispatch-for-this-turn"/);
});

test('a completed consultation cannot silence an actually thinking or waiting Pilot',()=>{
 assert.match(markup(pilot('running')),/正在思考/);
 for(const [status,label] of [['waiting_approval','等待确认'],['waiting_input','等待你补充信息'],['waiting_external','等待外部结果'],['queued','排队等待']]){
  const snapshot=pilot(status);snapshot.ai!.cards=[];
  assert.ok(markup(snapshot).includes(label!),`${status} remains visible even without a saved process card`);
 }
});

test('specialist process remains accessible in the live slot, adopted report and restored history',()=>{
 const worker={id:'worker',roleId:'role',roleName:'检查专员',sessionId:'source',assignmentState:'active',task:{taskId:'task',sessionId:'source',projectId:'project',title:'样例检查',state:'running' as const,acceptanceState:'not_evaluated' as const,revision:1,originRootTurnId:'task-origin',deadlineAt:at},activity:{phase:'thinking' as const,label:'正在分析',updatedAt:at,sourceSessionId:'pilot',sourceMessageId:user.id}};
 const w={...workspace,workers:[worker],conversations:[]};
 const row=pilotDispatchRows(w,'pilot',[user])[0]!;
 const report:Message={id:'report',sessionId:'pilot',role:'assistant',text:'唯一最终结论',createdAt:at,author:{...row.author,rootTurnId:'sdk-root'}};
 const onInspectSpecialist=()=>{};
 for(const finalReport of [undefined,report]){
  const html=renderToStaticMarkup(createElement(PilotSpecialistReplyView,{row:{...row,finalReport},onInspectSpecialist}));
  assert.equal((html.match(/data-specialist-process="task"/g)??[]).length,1);
  assert.match(html,/查看检查专员的执行过程/);
  assert.match(html,/<\/div><\/div><div class="reply-duration reply-process-text specialist-process-link"/,'process entry stays outside the animated body');
  if(finalReport)assert.equal((html.replace(/<[^>]*>/g,'').match(/唯一最终结论/g)??[]).length,1);
 }
 const restored=pilot();restored.messages.push({...report,replyToMessageId:user.id});
 const html=renderToStaticMarkup(createElement(AITranscript,{snapshot:restored,pilotWorkspace:{...w,workers:[{...worker,task:{...worker.task,state:'completed'}}]},assistantIdentity:{name:'Pilot',pilot:true},onInspectSpecialist}));
 assert.equal((html.match(/data-specialist-process="task"/g)??[]).length,1,'cold history has no live slot but retains its exact process entry');
 assert.match(html,/>Pilot 执行过程</);
 assert.doesNotMatch(markup(pilot()),/>Pilot 执行过程</,'a lone Pilot entry keeps its concise label');
 assert.equal((html.replace(/<[^>]*>/g,'').match(/唯一最终结论/g)??[]).length,1);
});

test('each specialist footer uses its own duration and keeps the exact task target',()=>{
 const snapshot=pilot();
 const author={kind:'specialist' as const,name:'检查专员',roleId:'role',workerId:'worker',sessionId:'source',taskId:'task'};
 const first:Message={id:'first',sessionId:'pilot',role:'assistant',text:'第一份报告',author,replyToMessageId:user.id,createdAt:'2026-11-16T00:00:12Z'};
 const last:Message={...first,id:'last',text:'第二份报告',createdAt:'2026-11-16T00:00:28Z',author:{...author,taskId:'task-two',sessionId:'source-two',workerId:'worker-two'}};
 snapshot.messages.push(first,last);
 const render=()=>renderToStaticMarkup(createElement(SessionInspectorProvider,{children:createElement(AITranscript,{snapshot,assistantIdentity:{name:'Pilot',pilot:true},onInspectSpecialist(){}})}));
 const noTime=render();
 assert.match(noTime,/查看检查专员的执行过程/);assert.doesNotMatch(noTime,/turn-status-elapsed/);
 snapshot.replyTimings=[{messageId:user.id,startedAt:at,finishedAt:'2026-11-16T00:00:29Z',status:'completed'}];
 assert.doesNotMatch(render(),/turn-status-elapsed/,'unknown specialist time never inherits the Pilot clock');
 snapshot.messages=[user,{...first,author:{...first.author!,durationMs:13000}},{...last,author:{...last.author!,durationMs:82000}}];
 const html=render();
 assert.equal((html.match(/turn-duration-disclosure/g)??[]).length,2);
 assert.equal((html.match(/turn-status-elapsed/g)??[]).length,2);
 const positions=['第一份报告','data-specialist-process="task"','13 秒','第二份报告','data-specialist-process="task-two"','1 分钟 22 秒'].map(text=>html.indexOf(text));
 assert.ok(positions.every((n,i)=>n>=0&&(!i||n>positions[i-1]!)));
 assert.doesNotMatch(html,/29 秒/);
 assert.doesNotMatch(html.match(/<button[^>]*data-specialist-process="task-two"[^>]*>[\s\S]*?<\/button>/)?.[0]??'',/用时/);
 snapshot.messages=[user];snapshot.ai!.cards=[];
 const timeOnly=render();assert.doesNotMatch(timeOnly,/turn-status-elapsed|turn-duration-disclosure/);
 snapshot.messages.push({...last,replyToMessageId:undefined});
 const unbound=render();
 assert.match(unbound,/第二份报告/);
 assert.doesNotMatch(unbound,/turn-status-elapsed/);
});

test('channel conversation replies without a task never fabricate a task process target',()=>{
 const author={kind:'specialist' as const,name:'报数专员',workerId:'member',roleId:'role',sessionId:'speaker',conversationId:'round'};
 assert.equal(renderToStaticMarkup(createElement(SpecialistProcessLink,{author,onInspect(){}})),'');
});
