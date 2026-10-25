import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {AIQuestionRequest,SessionSnapshot,SRETask,SRETranscriptEntry} from '../../shared/contracts';
import {LakePilotControl} from '../src/LakePilotControl';
import {PilotAgentWork} from '../src/PilotAgentWork';
import {pilotWorkForEntry,pilotStepStatus} from '../src/pilotPresentation';
import {PilotChoiceQuestion} from '../src/PilotChoiceQuestion';

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
 const html=renderToStaticMarkup(createElement(PilotAgentWork,{task,entry}));
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

test('Guided choices are nested directions and concrete unchecked changes, not ordinary skippable questions',()=>{
 const request:AIQuestionRequest={id:'choice',questions:[{id:'pilot',title:'选择'}],pilot:{sessionId:'session',taskId:'task',planRevisionId:'plan',stepId:'logs',attemptId:'attempt',role:'investigator',directions:[{id:'logs',title:'检查应用日志',reason:'核对故障时间',recommended:true,operations:[{id:'read',title:'查看日志',tool:'shell',arguments:{command:'journalctl -u demo'},risk:'readonly'},{id:'change',title:'修正配置',tool:'write',arguments:{path:'/tmp/config'},risk:'write'}]}]}};
 const html=renderToStaticMarkup(createElement(PilotChoiceQuestion,{session:'session',request,refresh:async()=>{}}));
 assert.match(html,/交给 Lake 完成本步骤/);assert.match(html,/按此方向继续/);assert.match(html,/执行所选检查/);assert.match(html,/journalctl -u demo/);
 assert.equal((html.match(/checked=""/g)??[]).length,1);assert.ok(!html.includes('其他 / 补充'));
});
