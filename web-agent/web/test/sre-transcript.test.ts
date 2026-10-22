import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {SessionSnapshot,SRETask,SRETranscriptEntry} from '../../shared/contracts';
import {sreEntries,sreCanStart,sreStepAttempt,sreReplyStage} from '../src/sreTranscript';
import {orderedTranscript} from '../src/timeline';
import {AITranscript,AIPending} from '../src/AIPanel';
import {AgentIcon} from '../src/AgentIcon';
import {mentionOptions} from '../src/composerMentionState';
import {referencedExtensions,rebaseExtensionReferences} from '../../shared/references';
import {roleReport,reportEvidence} from './fixtures/sre-report';
import {SREReport,SREProse} from '../src/SREReport';

const at='2026-10-15T10:00:00Z';
const message=(patch:Partial<SRETranscriptEntry>={}):SRETranscriptEntry=>({id:'message',sessionId:'session',taskId:'task',roleId:'coordinator',roleRunId:'real-role',kind:'plan',body:'已明确任务范围',revision:1,sequence:1,planVersion:1,createdAt:at,...patch});
const task=(patch:Partial<SRETask>={}):SRETask=>({id:'task',sessionId:'session',projectId:'project',requestId:'request',goal:'调查测试服务',scope:['host'],mode:'plan_only',status:'draft',outcome:'',recoveryStatus:'unverified',rootCauseStatus:'unknown',profileId:'lake.sre.assisted',profileVersion:1,revision:1,tokenBudget:128000,budgetSpent:100,usage:{input:50,output:50,total:100},plans:[{id:'plan',taskId:'task',version:1,goal:'调查测试服务',taskType:'investigation',scope:['host'],steps:[{id:'observe',role:'investigator',kind:'observe',description:'查询真实状态',capability:'host',resourceIds:['host'],dependsOn:[],completionChecks:['记录证据']}],acceptance:[],changeReason:'初始计划',createdAt:at}],runs:[],attempts:[],messages:[message()],verifications:[],createdAt:at,updatedAt:at,...patch});
const snapshot=(tasks:SRETask[]=[task()]):SessionSnapshot=>({session:{id:'session',projectId:'project'},messages:[{id:'user',sessionId:'session',role:'user',text:'调查测试服务',createdAt:'2026-10-15T09:59:59Z'}],resources:[{id:'host',name:'测试主机'}],specialists:[],evidence:[],actions:[],terminals:[],cursor:0,ai:{session:'session',status:'completed',profile:'core',cards:[],cardsOffset:0,totalCards:0,usage:{input:0,output:0,total:0},turns:1,agentRuns:[]},sre:{enabled:true,featureVersion:1,tasks}} as SessionSnapshot);

test('SRE messages use real ownership and revision while preserving their original anchor',()=>{
 const current=task({messages:[message({body:'updated',revision:2}),message({id:'foreign',sessionId:'other'})]});
 const older=task({messages:[message({body:'old',revision:1})]});
 const entries=sreEntries(snapshot([older,current]));assert.equal(entries.length,1);assert.equal(entries[0]!.entry.body,'updated');assert.equal(entries[0]!.entry.createdAt,at);
});
test('role messages render inline with Plan and real resource names, without a separate agent dashboard',()=>{
 const html=renderToStaticMarkup(createElement(AITranscript,{snapshot:snapshot()}));
 for(const text of ['协调者','Plan','查询真实状态','调查员','测试主机','开始执行'])assert.ok(html.includes(text),text);
 assert.ok(!html.includes('agent-task-list'));assert.ok(!html.includes('sre-role-executor'));assert.ok(!html.includes('sre-role-verifier'));
});
test('a newly persisted draft renders before any run or attempt exists',()=>{
 const draft=task(JSON.parse('{"runs":null,"attempts":null,"verifications":null}'));
 const html=renderToStaticMarkup(createElement(AITranscript,{snapshot:snapshot([draft])}));
 for(const text of ['计划草稿','查询真实状态','待开始','开始执行'])assert.ok(html.includes(text),text);
 assert.equal(sreStepAttempt(draft,draft.plans[0]!.steps[0]!),undefined);
});
test('SRE-disabled history keeps its plan but cannot start another specialist run',()=>{
 const s=snapshot();s.sre!.enabled=false;
 const html=renderToStaticMarkup(createElement(AITranscript,{snapshot:s}));
 assert.ok(html.includes('Plan'));assert.ok(html.includes('请先开启 SRE 协作'));
 assert.ok(/disabled=""[^>]*>开始执行/.test(html));
});
test('SRE runtime rows do not duplicate the same role as legacy child task cards',()=>{
 const s=snapshot();s.ai!.agentRuns=[{id:'real-role',sessionId:'session',role:'host',sreTaskId:'task',sreRole:'coordinator',status:'completed',task:'plan',resourceIds:['host'],createdAt:at}];
 const entries=orderedTranscript(s,[],0);assert.equal(entries.filter(e=>e.sre).length,1);assert.equal(entries.filter(e=>e.agentRun).length,0);
});
test('unknown writes cannot show a resume button or count as completed',()=>{
 const t=task({status:'paused',runs:[{id:'run',taskId:'task',planRevisionId:'plan',profileVersion:1,status:'paused',startedAt:at}],attempts:[{id:'attempt',planRunId:'run',stepId:'observe',roleRunId:'real-role',status:'unknown',evidence:[],operations:[{id:'op',call:{id:'call',name:'write',arguments:'{}'},digest:'digest',resourceId:'host',status:'unknown',preparedAt:at}],startedAt:at}]});
 assert.equal(sreCanStart(t),false);const html=renderToStaticMarkup(createElement(AITranscript,{snapshot:snapshot([t])}));assert.ok(html.includes('结果待核实'));assert.ok(!html.includes('继续任务'));
});
test('lake ecosystem avatars have distinct unframed silhouettes and a maximum 22px size',()=>{
 const shapes=new Set<string>();for(const role of ['coordinator','investigator','executor','verifier'] as const){const html=renderToStaticMarkup(createElement(AgentIcon,{role,size:40}));assert.ok(html.includes('width="22"'));assert.ok(!html.includes('<circle'));assert.ok(!html.includes('background:'));shapes.add(html)}assert.equal(shapes.size,4);
});
test('role mentions are opt-in and keep their typed identity through queue editing',()=>{
 assert.equal(mentionOptions([],[],[]).length,0);const roles=mentionOptions([],[],[],true);assert.equal(roles.length,4);
 const text='@验证员 解释验收条件',ref={kind:'role' as const,resourceId:'verifier',label:'@验证员',start:0,end:4};const refs=referencedExtensions(text,[ref]);assert.equal(refs[0]!.role_id,'verifier');assert.equal(refs[0]!.server_id,undefined);assert.equal(rebaseExtensionReferences(text,'解释验收条件',refs).length,0);
});
test('SRE confirmation uses a compact vertical card and preserves actual dangerous-operation confirmation',()=>{
 const s=snapshot();const view={...s.ai!,pending:{id:'approval',call:{id:'call',name:'write',arguments:'{"path":"/tmp/config","content":"test"}'},target:'测试主机',risk:'dangerous',confirmation:'执行 测试主机',fingerprint:'fingerprint'}};
 const html=renderToStaticMarkup(createElement(AIPending,{session:'session',view,refresh:async()=>{},sreStep:{id:'write',role:'executor',kind:'act',description:'写入测试配置',resourceIds:['host'],dependsOn:[],completionChecks:['实际写入'],action:{tool:'write',arguments:{},reason:'测试',impact:'仅测试文件',rollback:'删除测试文件',stopCondition:'失败暂停'}}}));
 for(const text of ['sre-confirm-footer','写入测试配置','查看执行详情','尚未执行变更','执行 测试主机'])assert.ok(html.includes(text),text);assert.ok(/disabled=""[^>]*>确认并执行/.test(html));
});

 test('a revised draft cannot inherit completed steps from a superseded run',()=>{
 const t=task();const step=t.plans[0]!.steps[0]!;t.runs=[{id:'old-run',taskId:t.id,planRevisionId:'old-plan',profileVersion:1,status:'superseded',startedAt:at}];t.attempts=[{id:'old-attempt',planRunId:'old-run',stepId:step.id,roleRunId:'old-role',status:'succeeded',evidence:[],operations:[],startedAt:at}];
 assert.equal(sreStepAttempt(t,step),undefined);const html=renderToStaticMarkup(createElement(AITranscript,{snapshot:snapshot([t])}));assert.ok(html.includes('开始新计划'));assert.ok(html.includes('待开始'));
 });

test('stored assistant scope prompts render alongside an existing AI view',()=>{
 const s=snapshot([]);s.ai!.startedAt='2026-10-15T09:00:00Z';s.messages.push({id:'scope',sessionId:'session',role:'assistant',text:'请先用 @ 引用本次任务的目标资源，再开始 SRE 协作。',createdAt:at});
 const html=renderToStaticMarkup(createElement(AITranscript,{snapshot:s}));assert.ok(html.includes('请先用 @ 引用本次任务的目标资源'));assert.ok(html.includes('response-identity'));assert.ok(!html.includes('<small>系统</small>'));
});

test('investigation findings render recorded report sections with exact evidence references',()=>{
 const t=task({messages:[message({roleId:'investigator',kind:'finding',attemptId:'attempt',body:'旧版拼接正文'})],attempts:[{id:'attempt',planRunId:'run',stepId:'observe',roleRunId:'real-role',status:'succeeded',report:roleReport,evidence:reportEvidence,operations:[],startedAt:at}]});
 const html=renderToStaticMarkup(createElement(AITranscript,{snapshot:snapshot([t])}));
 for(const text of ['观察事实','待验证假设','尚未确认','后续检查','<strong>17%</strong>','<code>df -hT</code>','查看证据 1：磁盘与挂载检查'])assert.ok(html.includes(text),text);
 assert.equal((html.match(/class="sre-evidence-citation"/g)??[]).length,6);
 assert.ok(!html.includes('旧版拼接正文'));assert.ok(!html.includes(reportEvidence[0]!.id));
});

test('progress, errors and user messages do not inherit a completed investigation report',()=>{
 for(const patch of [{kind:'progress'},{kind:'error'},{kind:'finding',source:'user'}]){
  const t=task({messages:[message({roleId:'investigator',attemptId:'attempt',body:'本条消息',...patch})],attempts:[{id:'attempt',planRunId:'run',stepId:'observe',roleRunId:'real-role',status:'failed',report:roleReport,evidence:reportEvidence,operations:[],startedAt:at}]});
  const html=renderToStaticMarkup(createElement(AITranscript,{snapshot:snapshot([t])}));assert.ok(html.includes('本条消息'));assert.ok(!html.includes('观察事实'));
 }
});

test('report display hides empty sections and never invents a reference for absent evidence',()=>{
 const html=renderToStaticMarkup(createElement(SREReport,{report:{...roleReport,facts:[{statement:'记录原文',evidenceIds:['ev_22222222222222222222222222222222']}],hypotheses:[],unknowns:[],nextChecks:[]},evidence:reportEvidence,onEvidence:()=>{}}));
 assert.ok(html.includes('记录原文'));assert.ok(!html.includes('sre-evidence-citation'));assert.ok(!html.includes('待验证假设'));assert.ok(!html.includes('尚未确认'));assert.ok(!html.includes('后续检查'));
});

test('specialist Markdown renders tables and code while suppressing raw HTML and unsafe URLs',()=>{
 const html=renderToStaticMarkup(createElement(SREProse,{children:'### 检查结果\n\n| 指标 | 数值 |\n| --- | --- |\n| 磁盘 | 17% |\n\n`/var/log`\n\n<script>alert(1)</script>\n\n[危险](javascript:alert(1))'}));
 assert.ok(html.includes('<h3>检查结果</h3>'));assert.ok(html.includes('markdown-table-scroll'));assert.ok(html.includes('data-object-kind="file"')&&html.includes('>/var/log</span>'));assert.ok(!html.includes('<script>'));assert.ok(!html.includes('javascript:'));
});

test('successful SRE operations collapse together while unknown outcomes stay visible',()=>{
 const operations=Array.from({length:15},(_,i)=>({id:`op-${i}`,call:{id:`call-${i}`,name:'shell',arguments:'{}'},digest:'digest',resourceId:'host',status:'succeeded',preparedAt:at}));
 operations.push({...operations[0]!,id:'unknown-op',status:'unknown'});
 const t=task({status:'paused',messages:[message({roleId:'investigator',kind:'error',attemptId:'attempt',body:'context compaction: model response incomplete'})],attempts:[{id:'attempt',planRunId:'run',stepId:'observe',roleRunId:'real-role',status:'failed',evidence:[],operations,startedAt:at}]});
 const html=renderToStaticMarkup(createElement(AITranscript,{snapshot:snapshot([t])}));
 assert.ok(/<details class="sre-operation-group"><summary[^>]*>/.test(html));assert.ok(html.includes('15 项操作记录'));
 assert.ok(html.includes('结果待核实'));assert.ok(html.includes('记录核实结果'));assert.ok(html.includes('上下文整理未完成，已保留本次证据。可继续任务。'));assert.ok(!html.includes('context compaction:'));
});

test('same-attempt fatal errors render once; errors from another turn remain',()=>{
 const failure='context compaction: model response incomplete',finished='2026-10-15T10:03:00Z';
 const t=task({status:'paused',messages:[message({roleId:'investigator',kind:'error',attemptId:'attempt',body:failure})],attempts:[{id:'attempt',planRunId:'run',stepId:'observe',roleRunId:'real-role',status:'failed',evidence:[],operations:[],startedAt:at,finishedAt:finished}]});
 const s=snapshot([t]);s.messages.push({id:'system-error',sessionId:'session',role:'system',text:failure,createdAt:finished});
 const errorCard={id:'fatal',type:'error',content:failure,status:'failed',at:finished};
 const rows=orderedTranscript(s,[errorCard],0);assert.equal(rows.filter(row=>row.card?.type==='error'||row.message?.role==='system').length,0);assert.equal(rows.filter(row=>row.sre?.entry.kind==='error').length,1);
 s.messages.push({id:'new-user',sessionId:'session',role:'user',text:'新问题',createdAt:'2026-10-15T10:04:00Z'},{id:'other-error',sessionId:'session',role:'system',text:failure,createdAt:'2026-10-15T10:05:00Z'});
 assert.ok(orderedTranscript(s,[errorCard],0).some(row=>row.message?.id==='other-error'));
});

test('directed specialist collaboration renders peers and real live statuses without repeating journals',()=>{
 const t=task({status:'active',messages:[message({roleId:'investigator',kind:'collaboration',attemptId:'attempt',toRoleId:'verifier',body:'请独立复核健康端点。'}),message({id:'live-verifier',roleId:'verifier',roleRunId:'verifier-run',kind:'progress',body:'正在对照实际响应。',sequence:2})],attempts:[{id:'attempt',planRunId:'run',stepId:'observe',roleRunId:'real-role',status:'running',evidence:reportEvidence,operations:[{id:'op',call:{id:'call',name:'shell',arguments:'{}'},digest:'digest',resourceId:'host',status:'succeeded',preparedAt:at}],startedAt:at}]});
 const s=snapshot([t]);s.ai!.agentRuns=[{id:'verifier-run',sessionId:'session',role:'verify',sreTaskId:'task',sreRole:'verifier',status:'running',task:'独立复核',resourceIds:['host'],createdAt:at}];
 const html=renderToStaticMarkup(createElement(AITranscript,{snapshot:s}));
 assert.ok(html.includes('sre-role-recipient'));assert.ok(html.includes('请独立复核健康端点。'));assert.ok(html.includes('正在对照实际响应。'));assert.ok(html.includes('执行中'));assert.ok(!html.includes('sre-operation-group'));assert.ok(!html.includes('查看原始输出'));
});

test('one live specialist approval is anchored once despite multiple team messages',()=>{
 const t=task({messages:[message({id:'progress',roleId:'investigator',kind:'progress',body:'正在检查。'}),message({id:'request',roleId:'investigator',kind:'collaboration',toRoleId:'verifier',body:'请复核。',sequence:2}),message({id:'broadcast',roleId:'investigator',kind:'collaboration',body:'已有初步发现。',sequence:3})]});
 const s=snapshot([t]);s.ai!.agentRuns=[{id:'real-role',sessionId:'session',role:'host',sreTaskId:'task',sreRole:'investigator',status:'waiting_approval',task:'检查',resourceIds:['host'],createdAt:at,pending:{id:'approval',call:{id:'call',name:'read',arguments:'{}'},target:'测试主机',risk:'normal',fingerprint:'fingerprint'}}];
 const html=renderToStaticMarkup(createElement(AITranscript,{snapshot:s}));
 assert.equal((html.match(/class="sre-approval-slot"/g)??[]).length,1);assert.ok(html.includes('等待确认'));assert.ok(html.includes('请复核。'));assert.ok(html.includes('已有初步发现。'));
});

test('legacy sequential plans explain role ordering and upgraded steps identify carried evidence',()=>{
 const t=task();const first=t.plans[0]!.steps[0]!;t.plans[0]!.steps.push({...first,id:'other',description:'其他独立取证'});
 let html=renderToStaticMarkup(createElement(AITranscript,{snapshot:snapshot([t])}));assert.ok(html.includes('当前为顺序分工：调查员先完成采集，协调者再汇总。'));
 t.plans[0]!.collaborationVersion=1;t.runs=[{id:'run',taskId:'task',planRevisionId:'plan',profileVersion:1,status:'running',startedAt:at}];t.attempts=[{id:'copy',planRunId:'run',stepId:'observe',roleRunId:'old-role',status:'succeeded',reusedFromAttemptId:'original',evidence:[],operations:[],startedAt:at,finishedAt:at}];
 html=renderToStaticMarkup(createElement(AITranscript,{snapshot:snapshot([t])}));assert.ok(html.includes('已沿用'));assert.ok(html.includes('沿用已有完成记录，未重新执行'));assert.ok(!html.includes('当前为顺序分工'));
});

test('live specialists show sustained activity; stopped, paused and approval states never animate execution',()=>{
 const t=task({status:'active',messages:[message({kind:'progress',roleId:'investigator',attemptId:'attempt',body:'正在检查。'})],runs:[{id:'run',taskId:'task',planRevisionId:'plan',profileVersion:1,status:'running',startedAt:at}],attempts:[{id:'attempt',planRunId:'run',stepId:'observe',roleRunId:'real-role',status:'running',evidence:reportEvidence,operations:[],startedAt:at}]});
 const s=snapshot([t]);s.ai!.agentRuns=[{id:'real-role',sessionId:'session',sreTaskId:'task',sreRole:'investigator',role:'host',status:'running',activityPhase:'tool',activityTool:'read',task:'检查',resourceIds:['host'],toolCount:2,createdAt:at,startedAt:at}];
 let html=renderToStaticMarkup(createElement(AITranscript,{snapshot:s}));
 for(const x of ['sre-live-activity','sre-activity-orbit','status-text--active','正在读取文件与日志','已调用 2 次工具','已采集 1 项证据'])assert.ok(html.includes(x),x);
 for(const status of ['completed','failed','cancelled','interrupted','waiting_approval'] as const){s.ai!.agentRuns[0]!.status=status;html=renderToStaticMarkup(createElement(AITranscript,{snapshot:s}));assert.ok(!html.includes('sre-live-activity'),status)}
 s.ai!.agentRuns[0]!.status='running';t.status='paused';html=renderToStaticMarkup(createElement(AITranscript,{snapshot:s}));assert.ok(!html.includes('sre-live-activity'));assert.ok(html.includes('已暂停'));
 t.status='active';s.ai!.agentRuns[0]!.activityPhase='waiting_resource';html=renderToStaticMarkup(createElement(AITranscript,{snapshot:s}));assert.ok(html.includes('等待资源空闲'));
});

test('unknown operation overrides running plan status and has an exact inspect anchor',()=>{
 const op={id:'uncertain',call:{id:'call',name:'shell',arguments:'{}'},digest:'digest',resourceId:'host',status:'unknown',preparedAt:at};
 const t=task({status:'paused',error:'操作结果不明，请核实实际状态；不会自动重放。',runs:[{id:'run',taskId:'task',planRevisionId:'plan',profileVersion:1,status:'paused',startedAt:at}],attempts:[{id:'attempt',planRunId:'run',stepId:'observe',roleRunId:'real-role',status:'running',evidence:[],operations:[op],startedAt:at}],messages:[message(),message({id:'failed',roleId:'investigator',kind:'error',attemptId:'attempt',body:'操作需要核实',sequence:2})]});
 assert.equal(sreStepAttempt(t,t.plans[0]!.steps[0]!)?.status,'unknown');
 const html=renderToStaticMarkup(createElement(AITranscript,{snapshot:snapshot([t])}));
 for(const text of ['1 项操作结果待核实','查看并核实','id="sre-operation-uncertain"','记录核实结果'])assert.ok(html.includes(text),text);
 assert.ok(!html.includes('继续任务'));assert.ok(!html.includes('sre-live-activity'));assert.ok(!html.includes('操作结果不明，请核实实际状态；不会自动重放。'));
});

test('unchanged message text still receives the newest task execution state',()=>{
 const old=task({revision:2}),latest=task({revision:4,status:'active'});
 const rows=sreEntries(snapshot([old,latest]));assert.equal(rows[0]!.task.revision,4);assert.equal(rows[0]!.task.status,'active');
});

test('untracked tool approval is reflected by the same role in Plan and conversation',()=>{
 const t=task({status:'active',runs:[{id:'run',taskId:'task',planRevisionId:'plan',profileVersion:1,status:'running',startedAt:at}],messages:[message(),message({id:'live',roleId:'investigator',kind:'progress',attemptId:'attempt',sequence:2,body:'等待读取确认'})],attempts:[{id:'attempt',planRunId:'run',stepId:'observe',roleRunId:'real-role',status:'running',evidence:[],operations:[],startedAt:at}]});
 const s=snapshot([t]);s.ai!.agentRuns=[{id:'real-role',sessionId:'session',sreTaskId:'task',role:'host',status:'waiting_approval',task:'读取文件',resourceIds:['host'],createdAt:at}];
 const html=renderToStaticMarkup(createElement(AITranscript,{snapshot:s}));assert.ok(html.includes('state-waiting_approval'));assert.ok(html.includes('等待确认'));assert.ok(!html.includes('sre-live-activity'));
});


test('node reports display the complete result while retaining evidence references',()=>{
 const html=renderToStaticMarkup(createElement(SREReport,{compact:true,report:roleReport,evidence:reportEvidence,onEvidence:()=>{}}));
 assert.ok(html.includes('根分区使用率'));
 assert.ok(!html.includes('<details'));
 assert.ok(html.includes('查看证据 1：磁盘与挂载检查'));assert.ok(html.includes('尚未确认'));
});
test('legacy coordinator analysis keeps its stage and all reply content stays expanded',()=>{
 const t=task();const base=t.plans[0]!.steps[0]!;
 t.plans[0]!.steps=[{...base,id:'analysis',role:'coordinator',kind:'analyze'},{...base,id:'final',role:'coordinator',kind:'summarize'}];
 t.runs=[{id:'run',taskId:t.id,planRevisionId:'plan',profileVersion:1,status:'completed',startedAt:at}];
 t.attempts=['analysis','final'].map(id=>({id,planRunId:'run',stepId:id,roleRunId:id,status:'succeeded',evidence:[],operations:[],startedAt:at}));
 const body='本节点实际报告。'.repeat(80);
 const analysis=message({id:'analysis',kind:'summary',attemptId:'analysis',roleRunId:'analysis',body});
 const final=message({id:'final',kind:'summary',attemptId:'final',roleRunId:'final',body:'最终结论：服务正常，时间同步仍需处理。',sequence:2});
 t.messages=[analysis,final];
 assert.equal(sreReplyStage(t,analysis),'node');assert.equal(sreReplyStage(t,final),'final');
 assert.equal(sreReplyStage(t,{...analysis,kind:'error'}),null);assert.equal(sreReplyStage(t,{...analysis,kind:'collaboration'}),null);
 const html=renderToStaticMarkup(createElement(AITranscript,{snapshot:snapshot([t])}));
 assert.equal((html.match(/查看节点小结/g)??[]).length,0);assert.ok(html.includes(final.body));assert.ok(html.includes(body));
});
test('completed status duplicates disappear only when their own node reply is present',()=>{
 const t=task();const status=message({id:'status',kind:'status',source:'runtime',attemptId:'a',body:'本步工作已完成。'});
 const reply=message({id:'reply',kind:'finding',attemptId:'a',body:'本节点已完成，未发现异常。',sequence:2});
 t.messages=[status,reply,message({id:'other',kind:'status',source:'runtime',attemptId:'b',body:status.body,sequence:3})];
 assert.deepEqual(sreEntries(snapshot([t])).map(x=>x.entry.id),['reply','other']);assert.equal(t.messages.length,3);
});

test('read timeout preserves its record with retry and never asks for human verification',()=>{
 const op={id:'read-timeout',call:{id:'read',name:'shell',arguments:'{"command":"uptime"}'},digest:'read',resourceId:'host',risk:'readonly',status:'unknown',preparedAt:at,result:'context deadline exceeded'};
 const t=task({status:'paused',runs:[{id:'run',taskId:'task',planRevisionId:'plan',profileVersion:1,status:'paused',startedAt:at}],attempts:[{id:'a',planRunId:'run',stepId:'observe',roleRunId:'real-role',status:'failed',evidence:[],operations:[op],startedAt:at}],messages:[message(),message({id:'read-error',roleId:'investigator',kind:'error',attemptId:'a',body:'只读检查未完成，可重新检查。'})]});
 assert.ok(sreCanStart(t));assert.equal(sreStepAttempt(t,t.plans[0]!.steps[0]!)?.status,'failed');
 const html=renderToStaticMarkup(createElement(AITranscript,{snapshot:snapshot([t])}));
 for(const text of ['继续任务','检查未完成，可重试','context deadline exceeded'])assert.ok(html.includes(text),text);
 for(const text of ['查看并核实','记录核实结果','项操作结果待核实'])assert.ok(!html.includes(text),text);
 const write=structuredClone(t);write.attempts[0]!.operations[0]!.risk='write';
 assert.ok(!sreCanStart(write));const blocked=renderToStaticMarkup(createElement(AITranscript,{snapshot:snapshot([write])}));assert.ok(blocked.includes('查看并核实'));assert.ok(blocked.includes('记录核实结果'));
});

test('still running operations show progress without a manual verification prompt or duplicate start',()=>{
 const t=task({status:'paused',attempts:[{id:'a',planRunId:'run',stepId:'observe',roleRunId:'r',status:'unknown',evidence:[],operations:[{id:'op',call:{id:'read',name:'shell',arguments:'{}'},digest:'r',resourceId:'host',risk:'readonly',status:'dispatched',preparedAt:at}],startedAt:at}]});
 assert.ok(!sreCanStart(t));const html=renderToStaticMarkup(createElement(AITranscript,{snapshot:snapshot([t])}));
 assert.ok(html.includes('原操作仍在执行'));assert.ok(!html.includes('查看并核实'));assert.ok(!html.includes('项操作结果待核实'));assert.ok(!html.includes('结果待核实'));
});
