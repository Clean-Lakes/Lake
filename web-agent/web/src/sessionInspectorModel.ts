import type {SessionSnapshot,SRETask} from '../../shared/contracts';
import type {InspectorSelection} from './SessionInspectorContext';
import {pilotIslandModel} from './pilotIslandModel';

export function inspectedTask(snapshot:SessionSnapshot,selection:InspectorSelection):SRETask|undefined{
 if(selection.sessionId!==snapshot.session.id)return;
 const task=snapshot.sre?.tasks.find(task=>task.id===selection.taskId)??selection.task;
 return task&&task.id===selection.taskId&&task.sessionId===snapshot.session.id&&task.projectId===snapshot.session.projectId?task:undefined;
}
export function inspectorAttempts(task:SRETask){
 const run=task.runs?.at(-1),plan=task.plans?.find(p=>p.id===run?.planRevisionId)??task.plans?.at(-1);
 return (plan?.steps??[]).flatMap(step=>{
  const attempt=task.attempts?.filter(a=>a.planRunId===run?.id&&a.stepId===step.id).at(-1);
  return attempt?[{step,attempt}]:[];
 });
}
export function inspectedAttempt(task:SRETask,attemptId?:string){
 const saved=task.attempts?.find(attempt=>attempt.id===attemptId);
 if(saved){
  const run=task.runs?.find(value=>value.id===saved.planRunId);
  const step=task.plans?.find(value=>value.id===run?.planRevisionId)?.steps.find(value=>value.id===saved.stepId);
  if(step)return {step,attempt:saved};
 }
 const attempts=inspectorAttempts(task);
 return attempts.find(item=>item.attempt.id===attemptId)??attempts.find(item=>['running','waiting_input','waiting_approval','unknown'].includes(item.attempt.status))??attempts.at(-1);
}

/** Header openings follow the current conversation, never a remembered history target. */
export function latestInspectorSelection(snapshot:SessionSnapshot,tab:InspectorSelection['tab']='execution'):InspectorSelection {
 const pilot=pilotIslandModel(snapshot),task=snapshot.sre?.tasks.find(task=>task.id===pilot?.taskId);
 const latestUser=(snapshot.messages??[]).filter(message=>message.role==='user').at(-1);
 const userAt=Date.parse(latestUser?.createdAt??''),started=Date.parse(snapshot.ai?.turnStartedAt??'');
 const currentTask=task&&(!Number.isFinite(userAt)||Date.parse(task.createdAt)>=userAt||
  started>=userAt&&!!snapshot.ai?.rootTurnId&&snapshot.ai.agentRuns?.some(run=>run.sreTaskId===task.id&&run.rootTurnId===snapshot.ai!.rootTurnId));
 return currentTask?{sessionId:snapshot.session.id,taskId:task.id,tab,followLatest:true}:{sessionId:snapshot.session.id,tab:'execution',followLatest:true};
}

export function resolvedInspectorSelection(snapshot:SessionSnapshot,selection:InspectorSelection|null):InspectorSelection|null {
 if(!selection||selection.sessionId!==snapshot.session.id)return null;
 if(!selection.followLatest)return selection;
 const current=latestInspectorSelection(snapshot,selection.tab);
 return selection.automatic===undefined?current:{...current,automatic:selection.automatic};
}
