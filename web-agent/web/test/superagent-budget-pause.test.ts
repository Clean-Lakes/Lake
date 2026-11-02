import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {AITranscript} from '../src/AIPanel';
import {SuperTaskInspector} from '../src/SuperTaskInspector';
import {displayAiError,isConversationInterruption} from '../src/aiErrors';
import type {SessionSnapshot,SuperTask,WorkGoal} from '../../shared/contracts';

const refusal="superagent: original task's cumulative model budget exhausted";
test('a stopped Worker shows one pause explanation while original diagnostics remain in activity',()=>{
 const at='2026-11-03T00:00:00Z';
 const snapshot={session:{id:'worker'},messages:[{id:'system-copy',role:'system',text:refusal,createdAt:at}],resources:[],actions:[],specialists:[],evidence:[],ai:{session:'worker',status:'paused',cardsOffset:0,cards:[{id:'first',type:'error',status:'failed',at,content:refusal},{id:'second',type:'error',status:'paused',at,content:refusal}]}} as unknown as SessionSnapshot;
 const html=renderToStaticMarkup(createElement(AITranscript,{snapshot,assistantIdentity:{name:'服务状态专员'}}));
 assert.equal(html.split('本任务的剩余执行额度不足').length-1,1);
 assert.match(html,/服务状态专员/);
 assert.match(html,/response-avatar/);
 assert.doesNotMatch(html,/cumulative model budget|ai-error/);
 const activity=renderToStaticMarkup(createElement(AITranscript,{snapshot,mode:'activity'}));
 assert.match(activity,/本任务的剩余执行额度不足/);
 assert.equal(snapshot.ai!.cards.length,2);
 assert.equal(snapshot.ai!.cards[0].content,refusal);
});

test('budget pause is distinct from a recoverable context-size error and has an explicit task reason',()=>{
 assert.ok(isConversationInterruption(refusal));
 assert.match(displayAiError(refusal),/尚未取得新的检查结果/);
 assert.ok(!isConversationInterruption('message exceeds configured context window'));
 const task={taskId:'task',sessionId:'worker',title:'检查服务',state:'paused',reason:'model_budget_exhausted',summary:'本任务剩余执行额度不足，尚无新的检查结果。',acceptanceState:'insufficient',revision:3} as SuperTask;
 const goal={items:[],modelRounds:13,roundLimit:500} as unknown as WorkGoal;
 const html=renderToStaticMarkup(createElement(SuperTaskInspector,{task,goal}));
 assert.match(html,/已暂停/);
 assert.match(html,/尚无新的检查结果/);
 assert.match(html,/本次执行额度不足/);
 assert.doesNotMatch(html,/13 \/ 500|已验收/);
});
