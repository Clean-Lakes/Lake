import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {AICard,SessionSnapshot,SuperTask,SuperWorker,TaskCollaboration,WorkGoal} from '../../shared/contracts';
import {SuperTaskInspector} from '../src/SuperTaskInspector';
import {canonicalGoalForExecution,inspectorGoal,inspectorWorker} from '../src/sessionInspectorModel';
import {channelTaskPresentation} from '../src/superAgentPresentation';
import {workerBusinessReceipts} from '../src/workerExecutionModel';

const collaboration:TaskCollaboration={
 state:'running',acceptanceState:'not_evaluated',participants:[
  {workerId:'wA',sessionId:'sa',roleId:'a',roleName:'运维专员',state:'completed',contributed:true},
  {workerId:'wB',sessionId:'sb',roleId:'b',roleName:'数据库专员',state:'running',contributed:false},
 ],
};
const workers:SuperWorker[]=collaboration.participants.map(member=>({
 id:member.workerId,roleId:member.roleId,roleName:member.roleName,sessionId:member.sessionId,assignmentState:'active',
 task:{taskId:'shared',executionGoalId:'exec-'+member.roleId,sessionId:member.sessionId,projectId:'p',title:'检查服务',state:member.state,acceptanceState:'not_evaluated',revision:3,originRootTurnId:'turn-'+member.roleId,deadlineAt:'',collaboration},
}));
const [a,b]=workers as [SuperWorker,SuperWorker];
const goal={id:'exec-b',sessionId:'sb',revision:3,items:[],modelRounds:1,roundLimit:10} as unknown as WorkGoal;
const receipt=(taskId:string)=>({id:taskId,type:'operation',title:'Read',status:'completed',data:{taskId,operation_id:'op-'+taskId}} as AICard);
const snapshot={session:{id:'sb',projectId:'p',workspaceRole:'worker'},superagent:{roleId:'b',task:b.task,goal},resources:[],ai:{cards:['exec-a','shared','exec-b'].map(receipt)}} as unknown as SessionSnapshot;

test('both channels see one task but inspection and evidence use the selected member session and execution',()=>{
 assert.equal(inspectorWorker([a,b],snapshot)?.id,'wB');
 assert.equal(inspectorWorker([a],snapshot),undefined);
 assert.equal(inspectorGoal(snapshot,'shared'),goal);
 assert.equal(inspectorGoal({...snapshot,superagent:{...snapshot.superagent!,goal:{...goal,id:'exec-a'}}},'shared'),undefined);
 assert.equal(canonicalGoalForExecution(snapshot,[receipt('exec-b')]),'shared');
 assert.equal(canonicalGoalForExecution(snapshot,[receipt('exec-a')]),undefined);
 assert.deepEqual(workerBusinessReceipts(snapshot).map(card=>card.id),['exec-b']);
});

test('a submitted contribution has a different label from unified acceptance in both participant channels',()=>{
 const render=(task:SuperTask,worker:SuperWorker)=>renderToStaticMarkup(createElement(SuperTaskInspector,{task,goal,worker,connected:true}));
 const own=render(a.task,a),other=render(b.task,b);
 for(const html of [own,other]){
  assert.match(html,/待统一验收/);
  assert.match(html,/1 \/ 2 位专员已提交/);
  assert.match(html,/运维专员/);assert.match(html,/数据库专员/);
  assert.doesNotMatch(html,/统一验收通过/);
 }
 assert.equal(channelTaskPresentation(a.task).label,'已提交');
 assert.equal(channelTaskPresentation(b.task).label,'执行中');
 assert.match(other,/aria-label="停止数据库专员参与「检查服务」的执行"/);
 assert.doesNotMatch(own,/停止本专员的执行/);
 const done:TaskCollaboration={state:'completed',acceptanceState:'pass',acceptanceId:'receipt',participants:collaboration.participants.map(member=>({...member,state:'completed',contributed:true}))};
 assert.match(render({...b.task,state:'completed',collaboration:done},b),/统一验收通过/);
});
