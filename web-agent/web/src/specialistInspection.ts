import type {SessionSnapshot,SpecialistReplyAuthor,SuperWorker,SuperWorkspace} from '../../shared/contracts';
import type {InspectorSelection} from './SessionInspectorContext';

export type SpecialistInspectionTarget={projectId:string;sessionId:string;taskId:string;roleId:string};

/** A history disclosure's selected tab survives the task snapshot fetch. */
export function selectedRoleInspection(selection:InspectorSelection,workers:readonly SuperWorker[]){
 if(!selection.canonicalGoalId||selection.followLatest)return;
 const worker=workers.find(value=>value.sessionId===selection.sessionId&&value.task.taskId===selection.canonicalGoalId);
 return worker?{worker,tab:selection.tab}:undefined;
}

/** A public author points to one worker, never the channel's most recent task. */
export function specialistInspectionWorker(author:SpecialistReplyAuthor,workspace:SuperWorkspace|null|undefined,projectId:string){
 if(!projectId||workspace?.project?.projectId!==projectId||!author.workerId||!author.sessionId||!author.taskId||!author.roleId)return;
 return workspace.workers.find(worker=>worker.id===author.workerId&&worker.sessionId===author.sessionId&&worker.roleId===author.roleId&&
  worker.task.taskId===author.taskId&&worker.task.sessionId===author.sessionId&&(!worker.task.projectId||worker.task.projectId===projectId));
}

export function workerInspectionTarget(worker:SuperWorker,projectId:string):SpecialistInspectionTarget|undefined{
 if(!projectId||!worker.sessionId||!worker.roleId||!worker.task.taskId||worker.task.sessionId!==worker.sessionId||worker.task.projectId&&worker.task.projectId!==projectId)return;
 return {projectId,sessionId:worker.sessionId,taskId:worker.task.taskId,roleId:worker.roleId};
}

export function snapshotInspectionTarget(snapshot:SessionSnapshot):SpecialistInspectionTarget|undefined{
 const task=snapshot.superagent?.task,roleId=snapshot.superagent?.roleId;
 if(!task||!roleId||!snapshot.session.projectId||task.sessionId!==snapshot.session.id||task.projectId&&task.projectId!==snapshot.session.projectId)return;
 return {projectId:snapshot.session.projectId,sessionId:snapshot.session.id,taskId:task.taskId,roleId};
}

/** Used on the initial read and every later refresh. Task-scoped snapshots may
 * rewrite ai.rootTurnId, so it is deliberately not an invocation identity here. */
export function matchesSpecialistInspection(snapshot:SessionSnapshot,target:SpecialistInspectionTarget){
 const task=snapshot.superagent?.task;
 return snapshot.session.id===target.sessionId&&snapshot.session.projectId===target.projectId&&
  (snapshot.session.workspaceRole==='worker'||(snapshot.session.workspaceRole==='router'||snapshot.session.workspaceRole==='group')&&target.roleId===`pilot:${target.projectId}`)&&
  snapshot.superagent?.roleId===target.roleId&&task?.taskId===target.taskId&&task.sessionId===target.sessionId&&
  (!task.projectId||task.projectId===target.projectId);
}

/** Closing or choosing another target invalidates both pending opens and
 * already in-flight refreshes, even when the transport cannot be aborted. */
export class InspectionRequestGuard {
 private version=0;
 private controller:AbortController|undefined;
 cancel(){this.version++;this.controller?.abort();this.controller=undefined;}
 capture(){const version=this.version;return ()=>this.version===version;}
 begin(){
  this.cancel();const controller=new AbortController();this.controller=controller;
  const current=this.capture();
  return {signal:controller.signal,current:()=>current()&&!controller.signal.aborted};
 }
}
