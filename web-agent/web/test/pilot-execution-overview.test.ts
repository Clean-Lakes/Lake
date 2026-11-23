import assert from 'node:assert/strict';
import test from 'node:test';
import type {AICard,Message,SuperWorker,SuperWorkspace} from '../../shared/contracts';
import {latestPilotTaskAssignments,pilotExecutionSteps} from '../src/pilotExecutionOverviewModel';

const at=(seconds:number)=>new Date(Date.UTC(2026,10,23,1,0,seconds)).toISOString();
const pilot={id:'pilot',projectId:'project'};
const input:Message={id:'input',sessionId:pilot.id,role:'user',text:'核对文档和发布申请',createdAt:at(0)};

function worker(id:string,taskId:string,seconds:number,source?:string):SuperWorker{
 return {id,roleId:`role-${id}`,roleName:id,sessionId:`worker-${id}`,createdAt:at(seconds),assignmentState:'released',
  pilotSourceMessageId:source,task:{taskId,sessionId:`worker-${id}`,projectId:pilot.projectId,title:taskId,state:'completed',
   acceptanceState:'not_evaluated',revision:1,originRootTurnId:id,deadlineAt:at(59)}};
}

function dispatch(worker:SuperWorker,seconds:number,source=input.id):Message{
 return {id:`message-${worker.id}`,sessionId:pilot.id,role:'assistant',text:'派单',createdAt:at(seconds),
  dispatch:{id:'shared-receipt',workerId:worker.id,sessionId:worker.sessionId,taskId:worker.task.taskId,
   roleId:worker.roleId,roleName:worker.roleName,channelSessionId:`channel-${worker.id}`,instruction:'复查已发布文档',action:'followup',sourceMessageId:source}};
}

function report(worker:SuperWorker,seconds:number,source?:string):Message{
 return {id:`report-${worker.id}-${seconds}`,sessionId:pilot.id,role:'assistant',text:'文档没有变化',createdAt:at(seconds),replyToMessageId:source,
  author:{kind:'specialist',name:worker.roleName,workerId:worker.id,roleId:worker.roleId,sessionId:worker.sessionId,taskId:worker.task.taskId}};
}

test('Pilot shows the latest linked task with its exact Workers and same-input reports',()=>{
 const old=worker('旧任务专员','old-task',3,input.id);
 const release=worker('发布专员','current',1,'previous-input');
 const knowledge=worker('知识库专员','current',2,input.id);
 const unrelated=worker('另一个会话的专员','unrelated',22,'previous-input');
 const child={...worker('子 Worker','unexpected',23,input.id),parentWorkerId:release.id};
 const archived={...worker('归档专员','unexpected',24,input.id),assignmentState:'archived'};
 const foreign=worker('其他项目的专员','unexpected',25,input.id);
 foreign.task.projectId='another-project';
 const validReport=report(knowledge,9);
 knowledge.pilotReport={messageId:validReport.id,executionSettled:true};
 const workspace:SuperWorkspace={active:true,project:{projectId:pilot.projectId,routerSessionId:pilot.id,version:1},
  workers:[old,release,knowledge,unrelated,child,archived,foreign]};
 const committed=dispatch(release,6);
 const wrongReport={...report(release,20,input.id),author:{...report(release,20,input.id).author!,sessionId:knowledge.sessionId}};
 const assignments=latestPilotTaskAssignments(workspace,pilot,input,[
  committed,validReport,report(release,17,'previous-input'),report(knowledge,18,'previous-input'),wrongReport,
 ]);
 assert.deepEqual(assignments.map(({worker,instruction,report})=>[worker.id,instruction,report?.id]),[
  [release.id,committed.dispatch!.instruction,undefined],[knowledge.id,undefined,validReport.id],
 ]);
 assert.deepEqual(latestPilotTaskAssignments(workspace,pilot,{...input,id:'another-input'},[committed]),[]);
 assert.deepEqual(latestPilotTaskAssignments(workspace,{...pilot,projectId:'another-project'},input,[committed]),[]);
});

test('Pilot operations keep distinct Workers on a joint receipt and show newer work in order',()=>{
 const release=dispatch(worker('发布专员','current',1),5);
 const knowledge=dispatch(worker('知识库专员','current',2),5);
 const read:AICard={id:'read',type:'operation',title:'read_super_object',status:'completed',at:at(3)};
 const live:AICard={id:'new-route',type:'operation',title:'route_work',status:'running',at:at(7)};
 const hiddenList:AICard={id:'list',type:'operation',title:'list_specialists',status:'completed',at:at(2)};
 const summary:Message={...input,id:'final',role:'assistant',replyToMessageId:input.id,createdAt:at(12)};
 const steps=pilotExecutionSteps(
  [live,hiddenList,read].map(card=>({id:card.id,card,at:card.at})),input,[{id:summary.id,final:summary}],
  [release,knowledge,dispatch(worker('其他轮次专员','previous',2),11,'previous-input')],
 );
 assert.deepEqual(steps.map(step=>[step.id,step.label,!!step.running]),[
  [read.id,'查阅任务记录',false],
  [release.id,'补充任务给发布专员',false],
  [knowledge.id,'补充任务给知识库专员',false],
  [live.id,'派发专员任务',true],
  ['summary:final','回传汇总结论',false],
 ]);
 assert.equal(steps[1]?.description,release.dispatch!.instruction);
});

test('the operation timeline keeps the recorded time and distinguishes failures from uncertain results',()=>{
 const failed:AICard={id:'dispatch',type:'operation',title:'route_work',status:'failed',at:at(3)};
 const unknown:AICard={id:'lookup',type:'operation',title:'read_super_object',status:'unknown',at:at(7)};
 const steps=pilotExecutionSteps([unknown,failed].map(card=>({id:card.id,card,at:card.at})),input,[],[]);
 assert.deepEqual(steps.map(({id,at,status})=>[id,at,status]),[
  [failed.id,failed.at,{label:'失败',tone:'danger'}],
  [unknown.id,unknown.at,{label:'结果待核查',tone:'attention'}],
 ]);
});
