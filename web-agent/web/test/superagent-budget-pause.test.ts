import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {AITranscript} from '../src/AIPanel';
import {SuperTaskInspector} from '../src/SuperTaskInspector';
import {displayAiError,isConversationInterruption} from '../src/aiErrors';
import {superTaskHeaderPresentation} from '../src/superAgentPresentation';
import {SessionStateBadge} from '../src/SessionPresentation';
import type {SessionSnapshot,SuperTask,WorkGoal} from '../../shared/contracts';

const refusal="superagent: original task's cumulative model budget exhausted";
test('a stopped Worker shows one pause explanation while original diagnostics remain in activity',()=>{
 const at='2026-11-03T00:00:00Z';
 const snapshot={session:{id:'worker'},messages:[{id:'system-copy',role:'system',text:refusal,createdAt:at}],resources:[],actions:[],specialists:[],evidence:[],ai:{session:'worker',status:'paused',cardsOffset:0,cards:[{id:'first',type:'error',status:'failed',at,content:refusal},{id:'second',type:'error',status:'paused',at,content:refusal}]}} as unknown as SessionSnapshot;
 const html=renderToStaticMarkup(createElement(AITranscript,{snapshot,assistantIdentity:{name:'服务状态专员'}}));
 assert.equal(html.split('本任务的剩余执行额度不足').length-1,1);
 assert.doesNotMatch(html,/class="response-identity|<strong>服务状态专员<\/strong>/);
 assert.doesNotMatch(html,/response-avatar/);
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
 const task={taskId:'task',sessionId:'worker',title:'检查服务',state:'paused',reason:'model_round_limit',summary:'本任务剩余执行额度不足，尚无新的检查结果。',acceptanceState:'insufficient',revision:3} as SuperTask;
 const goal={items:[],modelRounds:500,roundLimit:500} as unknown as WorkGoal;
 const html=renderToStaticMarkup(createElement(SuperTaskInspector,{task,goal}));
 assert.match(html,/已暂停/);
 assert.match(html,/尚无新的检查结果/);
 assert.match(html,/模型调用轮数已达上限/);
 assert.doesNotMatch(html,/13 \/ 500|已验收/);
});

test('a restored ended invocation does not label its budget-paused task as ended',()=>{
 const task={state:'paused',reason:'model_round_limit'} as SuperTask;
 const html=renderToStaticMarkup(createElement(SessionStateBadge,{session:{status:'completed'} as SessionSnapshot['session'],...superTaskHeaderPresentation(task)}));
 assert.match(html,/已暂停/);
 assert.doesNotMatch(html,/已结束/);
 assert.equal(superTaskHeaderPresentation({...task,state:'running'}),undefined);
});

test('removing a legacy token ceiling supersedes its current pause notice without deleting diagnostics',()=>{
 const at='2026-11-03T00:00:00Z';
 const snapshot={session:{id:'worker'},messages:[],resources:[],actions:[],specialists:[],evidence:[],ai:{session:'worker',status:'blocked',cardsOffset:0,cards:[{id:'old-limit',type:'error',status:'failed',at,content:refusal}]}} as unknown as SessionSnapshot;
 const task={taskId:'task',sessionId:'worker',state:'blocked',reason:'token_limit_removed',summary:'累计 token 上限已取消，历史用量继续累计。'} as SuperTask;
 const html=renderToStaticMarkup(createElement(AITranscript,{snapshot,superTask:task}));
 assert.match(html,/累计 token 上限已取消/);
 assert.doesNotMatch(html,/剩余执行额度不足/);
 assert.equal(snapshot.ai!.cards[0].content,refusal);
 assert.equal(superTaskHeaderPresentation(task)?.status,'failed');
 assert.match(displayAiError('superagent: task model round limit reached'),/模型调用轮数上限/);
});
