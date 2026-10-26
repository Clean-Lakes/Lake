import type {SREOperation,PilotReadRecovery} from '../../shared/contracts';
export const sreNeedsVerification=(op:SREOperation)=>op.status==='unknown'&&op.risk!=='readonly';
export const sreBlocksResume=(op:SREOperation)=>op.status==='dispatched'||sreNeedsVerification(op);
export function sreReadCovered(operations:SREOperation[],recoveries:PilotReadRecovery[],failed:SREOperation){
 if(failed.risk!=='readonly'||!['unknown','failed'].includes(failed.status)||!failed.resourceId||!Number.isFinite(Date.parse(failed.finishedAt??'')))return false;
 return recoveries.some(recovery=>recovery.failedOperationId===failed.id&&!!recovery.reason.trim()&&recovery.replacementOperationIds.length>0&&recovery.replacementOperationIds.length<=12&&new Set(recovery.replacementOperationIds).size===recovery.replacementOperationIds.length&&recovery.replacementOperationIds.every(id=>{
  const replacement=operations.find(op=>op.id===id);
  return replacement?.id!==failed.id&&replacement?.risk==='readonly'&&replacement.status==='succeeded'&&!!replacement.evidenceIds?.length&&replacement.resourceId===failed.resourceId&&Date.parse(replacement.dispatchedAt??'')>=Date.parse(failed.finishedAt!)&&Date.parse(replacement.finishedAt??'')>=Date.parse(replacement.dispatchedAt??'');
 }));
}
export function sreIncompleteRead(operations:SREOperation[]=[],recoveries:PilotReadRecovery[]=[]){
 const pending=new Set<string>();
 for(const op of operations){
  if(op.risk!=='readonly')continue;
  const key=op.digest||`${op.call.name}:${op.call.arguments}`;
  if(op.status==='unknown'&&!sreReadCovered(operations,recoveries,op))pending.add(key);
  if(op.status==='succeeded')pending.delete(key);
 }
 return pending.size>0;
}
export function sreOperationLabel(op:SREOperation){
 if(op.status==='unknown'&&op.risk==='readonly')return '检查未完成，可重试';
 return ({prepared:'已准备',waiting_approval:'等待确认',dispatched:'仍在执行',succeeded:'执行成功，仍需验证',failed:'执行失败',unknown:'变更结果待核实',rejected:'已拒绝，未执行',not_executed:'未执行',interrupted:'已中断，未派发'} as Record<string,string>)[op.status]??op.status;
}
