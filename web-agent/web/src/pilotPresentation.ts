import type {AgentRun,SREPlanRevision,SREPlanStep,SRETask,SRETranscriptEntry} from '../../shared/contracts';
import {sreNeedsVerification,sreIncompleteRead} from './sreOperationPolicy';

const workKey=(step:SREPlanStep)=>step.assignmentId?JSON.stringify([step.role,step.assignmentId]):JSON.stringify([step.role,step.capability??'', [...step.resourceIds].sort()]);

// Resolve the plan of the actual attempt, not the newest plan in the session.
export function pilotWorkForEntry(task:SRETask,entry:SRETranscriptEntry,runs:AgentRun[]=[]){
 if(entry.source==='user'||!entry.attemptId)return null;
 const attempt=task.attempts.find(value=>value.id===entry.attemptId);
 const run=task.runs.find(value=>value.id===attempt?.planRunId);
 const plan=task.plans.find(value=>value.id===run?.planRevisionId);
 const step=plan?.steps.find(value=>value.id===attempt?.stepId);
 if(!plan||!step||step.role!==entry.roleId)return null;
 const key=workKey(step),steps=plan.steps.filter(value=>workKey(value)===key);
 const owns=(message:SRETranscriptEntry)=>{
  if(message.source==='user'||message.roleId!==entry.roleId)return false;
  const owner=task.attempts.find(value=>value.id===message.attemptId);
  return task.runs.some(value=>value.id===owner?.planRunId&&value.planRevisionId===plan.id)&&steps.some(value=>value.id===owner?.stepId);
 };
 const anchor=task.messages.filter(owns).sort((a,b)=>a.sequence-b.sequence||a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id))[0];
 if(anchor?.id!==entry.id)return null;
 const states=steps.map(value=>({step:value,status:pilotStepStatus(task,plan,value,runs)}));
 return {id:JSON.stringify([task.id,plan.id,key]),plan,steps:states,completed:states.filter(value=>value.status==='succeeded').length};
}

export function pilotStepStatus(task:SRETask,plan:SREPlanRevision,step:SREPlanStep,runs:AgentRun[]=[]):string{
 const run=task.runs.filter(value=>value.planRevisionId===plan.id).at(-1);
 const attempt=task.attempts.filter(value=>value.planRunId===run?.id&&value.stepId===step.id).at(-1);
 if(!attempt)return 'pending';
 if(attempt.operations?.some(sreNeedsVerification))return 'unknown';
 if(attempt.operations?.some(value=>value.status==='dispatched'))return 'running';
 if(sreIncompleteRead(attempt.operations??[]))return 'failed';
 const agent=runs.find(value=>value.id===attempt.roleRunId&&value.sreTaskId===task.id);
 if(agent?.question)return 'waiting_input';
 if(agent?.pending||attempt.operations?.some(value=>value.status==='waiting_approval'))return 'waiting_approval';
 // Completed commands do not replace the actual step's deliverable outcome.
 return attempt.status;
}
