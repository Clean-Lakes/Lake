import test from 'node:test';
import assert from 'node:assert/strict';
import type {SessionSnapshot} from '../../shared/contracts';
import {workGoalPresentation} from '../src/workGoalPresentation';
import {conversationActive} from '../src/connection';

function snapshot(status:string,origin='current'){
 return {session:{id:'session',status:'completed'},ai:{status:'waiting_external',rootTurnId:'current',workGoals:[{id:'goal',originRootTurnId:origin,status}]}} as unknown as SessionSnapshot;
}
test('external waiting stays active in the island while accepting a new message',()=>{
 const current=snapshot('waiting_external');
 assert.equal(workGoalPresentation(current)?.status,'investigating');
 assert.equal(conversationActive(current,'completed'),false,'a parked goal must release the message composer');
});
test('historical goal updates never replace the current topic status',()=>{
 assert.equal(workGoalPresentation(snapshot('running','old-turn')),undefined);
});
test('user dependencies, pause and terminal results remain distinct',()=>{
 assert.equal(workGoalPresentation(snapshot('waiting_user'))?.status,'waiting_approval');
 assert.equal(workGoalPresentation(snapshot('paused'))?.label,'任务已暂停');
 assert.equal(workGoalPresentation(snapshot('blocked'))?.status,'failed');
 assert.equal(workGoalPresentation(snapshot('completed'))?.status,'completed');
});
