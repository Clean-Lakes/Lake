import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {AIQuestionRequest,SessionSnapshot,SRETask,SRETranscriptEntry,SREOperation,PilotReadRecovery} from '../../shared/contracts';
import {LakePilotControl} from '../src/LakePilotControl';
import {PilotAgentWork} from '../src/PilotAgentWork';
import {pilotWorkForEntry,pilotStepStatus} from '../src/pilotPresentation';
import {PilotChoiceQuestion} from '../src/PilotChoiceQuestion';
import {sreRoleLiveState} from '../src/SREActivity';
import {SRERoleMessage} from '../src/SRERoleMessage';
import {sreIncompleteRead} from '../src/sreOperationPolicy';

const at='2026-10-25T00:00:00Z';
const entry:SRETranscriptEntry={id:'first',sessionId:'session',taskId:'task',roleId:'investigator',roleRunId:'agent',kind:'progress',body:'正在采集',revision:1,sequence:1,createdAt:at,attemptId:'attempt'};
const task={id:'task',plans:[{id:'plan',steps:[{id:'logs',role:'investigator',kind:'observe',description:'收集日志',resourceIds:['host'],dependsOn:[],completionChecks:['取得日志']},{id:'hypothesis',role:'investigator',kind:'analyze',description:'核对假设',resourceIds:['host'],dependsOn:['logs'],completionChecks:['核对证据']},{id:'database',role:'investigator',kind:'observe',description:'读取数据库状态',resourceIds:['db'],dependsOn:[],completionChecks:[]},{id:'change',role:'executor',kind:'act',description:'执行变更',resourceIds:['host'],dependsOn:['hypothesis'],completionChecks:['实际操作']}]}],runs:[{id:'run',planRevisionId:'plan'}],attempts:[{id:'attempt',planRunId:'run',stepId:'logs',roleRunId:'agent',status:'running',operations:[],evidence:[],startedAt:at}],messages:[entry,{...entry,id:'later',sequence:2}]} as SRETask;

test('Pilot uses gray/foreground textual enablement state and remains off by default',()=>{
 const snapshot={session:{id:'session',projectId:'project'},sre:{enabled:false,pilot:{enabled:false,autoAdvance:false,revision:0}}} as SessionSnapshot;
 const off=renderToStaticMarkup(createElement(LakePilotControl,{snapshot,onUpdated:async()=>{}}));
 assert.match(off,/Lake Pilot/);assert.match(off,/aria-pressed="false"/);assert.match(off,/pilot-mode-toggle/);assert.ok(!off.includes('SRE 协作'));assert.ok(!off.includes('role="switch"'));
 const on=renderToStaticMarkup(createElement(LakePilotControl,{snapshot:{...snapshot,sre:{...snapshot.sre!,enabled:true,pilot:{enabled:true,autoAdvance:false,revision:1}}},onUpdated:async()=>{}}));
 assert.match(on,/aria-pressed="true"/);
});

test('Each real Agent work item has its own steps and exactly one historical anchor',()=>{
 const work=pilotWorkForEntry(task,entry);
 assert.deepEqual(work?.steps.map(value=>value.step.description),['收集日志','核对假设']);
 assert.equal(pilotWorkForEntry(task,task.messages[1]!),null);
 const html=renderToStaticMarkup(createElement(PilotAgentWork,{work}));
 assert.ok(html.includes('收集日志'));assert.ok(!html.includes('读取数据库状态'));assert.ok(!html.includes('执行变更'));assert.match(html,/0 \/ 2/);
 assert.equal(pilotWorkForEntry(task,{...entry,source:'user'}),null);
});

test('Commands and unrelated plan revisions cannot inflate the displayed step progress',()=>{
 const withCommand={...task,attempts:[{...task.attempts[0]!,operations:[{id:'op',risk:'readonly',status:'succeeded',call:{id:'call',name:'read',arguments:'{}'}}]}]} as SRETask;
 assert.equal(pilotStepStatus(withCommand,task.plans[0]!,task.plans[0]!.steps[0]!),'running');
 const newer={...withCommand,plans:[...withCommand.plans,{...withCommand.plans[0]!,id:'new-plan',steps:[]}]} as SRETask;
 assert.equal(pilotWorkForEntry(newer,entry)?.steps.length,2);
 assert.equal(pilotWorkForEntry(newer,entry)?.completed,0);
});

test('Only the exact repeated step description is suppressed; findings and full inspection text stay available',()=>{
 const repeated={...entry,body:task.plans[0]!.steps[0]!.description};
 const withRepeated={...task,messages:[repeated,...task.messages.slice(1)]};
 const work=pilotWorkForEntry(withRepeated,repeated);
 assert.equal(work?.repeatsDescription,true);
 assert.equal(work?.steps[0]!.step.description,repeated.body);
 assert.equal(pilotWorkForEntry(task,entry)?.repeatsDescription,false);
 assert.equal(pilotWorkForEntry({...withRepeated,messages:[{...repeated,kind:'finding'}]},{...repeated,kind:'finding'})?.repeatsDescription,false);
});

test('A Pilot choice wait has a specific label and never shows running activity',()=>{
 const current={...task,status:'active'} as SRETask;
 const run={id:'agent',sreTaskId:task.id,status:'running',question:{pilot:{}}} as Parameters<typeof sreRoleLiveState>[2];
 const state=sreRoleLiveState(current,entry,run,task.attempts[0]);
 assert.equal(state.label,'等待选择');assert.equal(state.active,false);
});

test('Guided choices are nested directions and concrete unchecked changes, not ordinary skippable questions',()=>{
 const request:AIQuestionRequest={id:'choice',questions:[{id:'pilot',title:'选择'}],pilot:{sessionId:'session',taskId:'task',planRevisionId:'plan',stepId:'logs',attemptId:'attempt',role:'investigator',directions:[{id:'logs',title:'检查应用日志',reason:'核对故障时间',recommended:true,operations:[{id:'read',title:'查看日志',tool:'shell',arguments:{command:'journalctl -u demo'},risk:'readonly'},{id:'change',title:'修正配置',tool:'write',arguments:{path:'/tmp/config'},risk:'write'}]}]}};
 const html=renderToStaticMarkup(createElement(PilotChoiceQuestion,{session:'session',request,refresh:async()=>{}}));
 assert.match(html,/本步骤交给 Lake/);assert.match(html,/按此方向继续/);assert.match(html,/选择具体操作/);assert.match(html,/工具与参数/);assert.match(html,/journalctl -u demo/);assert.ok(!html.includes(' open=')&&!html.includes('<details open'));
 assert.equal((html.match(/checked=""/g)??[]).length,1);assert.ok(!html.includes('其他 / 补充'));
});


test('Pilot live narration stays behind a collapsed record and does not replace the main step text',()=>{
 const own={...entry,body:task.plans[0]!.steps[0]!.description};
 const active={...task,status:'active',pilot:{autoAdvance:true,settingsRevision:1},messages:[own]} as SRETask;
 const snapshot={session:{id:'session',projectId:'project'},resources:[],sre:{enabled:true,pilot:{enabled:true,autoAdvance:true,revision:1},tasks:[active]},ai:{agentRuns:[{id:'agent',sreTaskId:task.id,status:'running',createdAt:at,startedAt:at,liveTextId:'new-model-part',liveText:'不断变化的内部播报',activityPhase:'tool',activityTool:'grep'}]}} as SessionSnapshot;
 const html=renderToStaticMarkup(createElement(SRERoleMessage,{task:active,entry:own,snapshot,renderApproval:()=>null,onUpdated:()=>{}}));
 assert.ok(!html.includes('class="sre-role-body"'));assert.ok(!html.includes('status-text--active'));
 assert.match(html,/<details class="sre-live-record">/);assert.match(html,/运行详情/);assert.match(html,/不断变化的内部播报/);
});

test('Actual replacement reads remove the incomplete projection while unknown changes stay blocked',()=>{
 const operations=[{id:'old',risk:'readonly',status:'unknown',resourceId:'host',call:{name:'grep',arguments:'{}'},finishedAt:'2026-10-25T10:00:30Z'},{id:'new',risk:'readonly',status:'succeeded',resourceId:'host',evidenceIds:['evidence'],call:{name:'read',arguments:'{}'},dispatchedAt:'2026-10-25T10:00:31Z',finishedAt:'2026-10-25T10:00:32Z'}] as SREOperation[];
 const recovery={failedOperationId:'old',replacementOperationIds:['new'],reason:'完整的替代日志',createdAt:'2026-10-25T10:00:33Z'} as PilotReadRecovery;
 assert.equal(sreIncompleteRead(operations),true);assert.equal(sreIncompleteRead(operations,[recovery]),false);
 assert.equal(sreIncompleteRead([{...operations[0]!},{...operations[1]!,resourceId:'foreign'}],[recovery]),true);
 assert.equal(sreIncompleteRead([{...operations[0]!},{...operations[1]!,evidenceIds:[]}],[recovery]),true);
 const active={...task,pilot:{autoAdvance:true,settingsRevision:1},attempts:[{...task.attempts[0]!,operations}]} as SRETask;
 assert.equal(pilotStepStatus(active,task.plans[0]!,task.plans[0]!.steps[0]!),'running');
});


test('Pilot continues displaying active work while adapting a read failure; changes remain blocked',()=>{
 const current={...task,status:'active',pilot:{autoAdvance:true,settingsRevision:1}} as SRETask;
 const failed={id:'old',risk:'readonly',status:'unknown',call:{name:'grep',arguments:'{}'}} as SREOperation;
 const attempt={...task.attempts[0]!,status:'running',operations:[failed]} as SRETask['attempts'][number];
 const run={id:'agent',sreTaskId:task.id,status:'running'} as Parameters<typeof sreRoleLiveState>[2];
 const active=sreRoleLiveState(current,entry,run,attempt);assert.equal(active.active,true);assert.equal(active.label,'执行中');
 const ended=sreRoleLiveState({...current,status:'paused'},entry,run,{...attempt,status:'failed'});assert.equal(ended.active,false);assert.equal(ended.label,'检查未完成');
 const change=sreRoleLiveState(current,entry,run,{...attempt,operations:[{...failed,risk:'write'}]});assert.equal(change.active,false);assert.equal(change.label,'结果待核实');
});
