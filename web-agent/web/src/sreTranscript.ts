import {sreBlocksResume,sreNeedsVerification,sreIncompleteRead} from './sreOperationPolicy';
import type {SRETask,SREAgentRole,SREPlanStep,SREStepAttempt,SessionSnapshot,AgentRun} from '../../shared/contracts';

export const sreRoles:Record<SREAgentRole,{name:string;description:string}>={coordinator:{name:'协调者',description:'计划与调度'},investigator:{name:'调查员',description:'只读取证'},executor:{name:'执行员',description:'受控执行'},verifier:{name:'验证员',description:'独立复测'}};
export const sreStatus:Record<string,string>={draft:'计划草稿',active:'处理中',waiting_input:'待补充',waiting_approval:'待确认',paused:'已暂停',completed:'已结束',failed:'未完成',cancelled:'已取消',pending:'待开始',running:'执行中',succeeded:'已完成',unknown:'结果待核实',interrupted:'已中断',superseded:'已修订',queued:'排队中',skipped:'已跳过'};
export function sreEntries(snapshot:SessionSnapshot){
 const found=new Map<string,{entry:SRETask['messages'][number];task:SRETask}>();
 for(const task of snapshot.sre?.tasks??[])for(const entry of task.messages??[]){if(entry.sessionId!==snapshot.session.id||entry.taskId!==task.id)continue;const old=found.get(entry.id);if(!old||entry.revision>old.entry.revision||entry.revision===old.entry.revision&&task.revision>old.task.revision)found.set(entry.id,{entry,task});}
 const entries=[...found.values()];
 return entries.filter(({entry:m,task})=>!(m.kind==='status'&&m.source==='runtime'&&m.attemptId&&entries.some(({entry:other,task:owner})=>owner.id===task.id&&other.attemptId===m.attemptId&&other.roleRunId===m.roleRunId&&['finding','result','verification','summary'].includes(other.kind)&&(m.body==='本步工作已完成。'||m.body===other.body)))).sort((a,b)=>a.entry.sequence-b.entry.sequence||a.entry.createdAt.localeCompare(b.entry.createdAt)||a.entry.id.localeCompare(b.entry.id));
}
export function sreStepAttempt(task:SRETask,step:SREPlanStep):SREStepAttempt|undefined {const run=task.runs?.at(-1);if(!run||run.planRevisionId!==task.plans.at(-1)?.id)return undefined;const attempt=[...(task.attempts??[])].reverse().find(a=>a.stepId===step.id&&a.planRunId===run?.id);return attempt?.operations?.some(sreNeedsVerification)?{...attempt,status:'unknown'}:attempt?.operations?.some(o=>o.status==='dispatched')?{...attempt,status:'running'}:attempt&&sreIncompleteRead(attempt.operations)?{...attempt,status:'failed'}:attempt&&step.kind==='act'&&attempt.operations?.length&&attempt.operations.every(o=>o.status==='succeeded')?{...attempt,status:'succeeded'}:attempt?.operations?.some(o=>o.status==='waiting_approval')?{...attempt,status:'waiting_approval'}:attempt}
export const sreTaskActive=(task:SRETask)=>['draft','active','waiting_input','waiting_approval','paused'].includes(task.status);
export function sreCanStart(task:SRETask){return !!task.plans?.length&&['draft','paused','waiting_input'].includes(task.status)&&!task.attempts?.some(a=>a.operations?.some(sreBlocksResume))}

export function sreStepStatus(task:SRETask,step:SREPlanStep,runs:AgentRun[]=[]){
 const attempt=sreStepAttempt(task,step);
 if(!attempt)return 'pending';
 const run=runs.find(r=>r.id===attempt.roleRunId&&r.sreTaskId===task.id);
 if(attempt.status==='running'&&(run?.pending||run?.status==='waiting_approval'))return 'waiting_approval';
 return attempt.status;
}

// Resolve the actual historical plan; a coordinator's older "summary" message
// may belong to an analyze node rather than the task's final conclusion.
export function sreReplyStage(task:SRETask,entry:SRETask['messages'][number]):'node'|'final'|null{
 if(entry.source==='user'||!['finding','result','verification','summary'].includes(entry.kind))return null;
 const attempt=task.attempts?.find(a=>a.id===entry.attemptId);
 const run=task.runs?.find(r=>r.id===attempt?.planRunId);
 const step=task.plans?.find(p=>p.id===run?.planRevisionId)?.steps.find(s=>s.id===attempt?.stepId);
 if(!step)return null;
 return step.kind==='summarize'?'final':'node';
}
