import type {AICard,Resource,SREOperation,SREStepAttempt,SRETask} from '../../shared/contracts';
import {conversationGroups} from './conversation-progress-model';
import type {MiniCommandScope} from './miniBoxModel';

const object=(raw:string|undefined):Record<string,unknown>=>{try{const value=JSON.parse(raw??'{}');return value&&typeof value==='object'&&!Array.isArray(value)?value:{}}catch{return {}}};
export function pilotOperationCard(op:SREOperation,resources:Resource[]):AICard{
 const args=object(op.call.arguments),resource=resources.find(r=>r.id===op.resourceId);
 const status=({prepared:'pending',dispatched:'running',succeeded:'completed',not_executed:'not_executed',failed:'failed',unknown:'unknown',cancelled:'cancelled'} as Record<string,string>)[op.status]??'unknown';
 return {id:`pilot-operation-${op.id}`,type:'operation',title:op.call.name,status,at:op.dispatchedAt??op.preparedAt,content:op.result,data:{resource_id:op.resourceId,target:resource?.name??op.resourceId,arguments:args}};
}
export function pilotExecutionGroups(attempt:SREStepAttempt,resources:Resource[]){
 return conversationGroups((attempt.operations??[]).map(op=>{const card=pilotOperationCard(op,resources);return{id:card.id,at:card.at,card}}),resources);
}
export function pilotCommandScope(task:SRETask,attempt:SREStepAttempt):MiniCommandScope{
 return {owned:(attempt.operations??[]).map(op=>op.id),calls:(task.attempts??[]).flatMap(a=>(a.operations??[]).flatMap(op=>{
  if(!['shell','terminal_execute_command'].includes(op.call.name)||!op.dispatchedAt)return [];
  const args=object(op.call.arguments),result=object(op.result);
  if(typeof args.command!=='string')return [];
  return [{id:op.id,resource:op.resourceId,command:args.command,startedAt:op.dispatchedAt,
   terminalId:typeof result.terminal_id==='string'?result.terminal_id:typeof args.terminal_id==='string'?args.terminal_id:undefined,
   entryId:typeof result.entry_id==='string'?result.entry_id:undefined}];
 }))};
}
