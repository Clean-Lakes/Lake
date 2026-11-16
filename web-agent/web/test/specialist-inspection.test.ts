import assert from 'node:assert/strict';
import test from 'node:test';
import type {SessionSnapshot,SpecialistReplyAuthor,SuperWorker,SuperWorkspace} from '../../shared/contracts';
import {InspectionRequestGuard,matchesSpecialistInspection,selectedRoleInspection,snapshotInspectionTarget,specialistInspectionWorker,workerInspectionTarget} from '../src/specialistInspection';
import {inspectedCanonicalTask,latestInspectorSelection} from '../src/sessionInspectorModel';

const worker:SuperWorker={id:'worker',roleId:'role',roleName:'检查专员',sessionId:'worker-session',assignmentState:'parked',task:{taskId:'task',sessionId:'worker-session',projectId:'project',title:'样例任务',state:'completed',acceptanceState:'pass',revision:1,summary:'正式结果',originRootTurnId:'task-origin'}};
const author:SpecialistReplyAuthor={kind:'specialist',name:'检查专员',workerId:worker.id,roleId:worker.roleId,sessionId:worker.sessionId,taskId:worker.task.taskId,rootTurnId:'sdk-root',channelSessionId:'channel'};
const workspace={active:true,project:{projectId:'project'},workers:[worker]} as SuperWorkspace;
function snapshot():SessionSnapshot{return {session:{id:worker.sessionId,projectId:'project',workspaceRole:'worker'},superagent:{roleId:worker.roleId,task:{...worker.task}},ai:{session:worker.sessionId,rootTurnId:'task-origin',status:'completed',cards:[]}} as unknown as SessionSnapshot;}

test('a public specialist author resolves only its exact worker within the current Pilot project',()=>{
 assert.equal(specialistInspectionWorker(author,workspace,'project'),worker);
 for(const patch of [{workerId:'other'},{sessionId:'other'},{taskId:'other'},{roleId:'other'},{taskId:undefined},{roleId:undefined}])
  assert.equal(specialistInspectionWorker({...author,...patch},workspace,'project'),undefined);
 assert.equal(specialistInspectionWorker(author,workspace,'another-project'),undefined);
 assert.equal(specialistInspectionWorker(author,{...workspace,workers:[]},'project'),undefined,'a removed historical worker is not replaced by the latest channel task');
 assert.equal(specialistInspectionWorker(author,{...workspace,workers:[{...worker,task:{...worker.task,projectId:'other'}}]},'project'),undefined);
 assert.equal(specialistInspectionWorker(author,{...workspace,workers:[{...worker,task:{...worker.task,sessionId:'other'}}]},'project'),undefined);
 assert.equal(workerInspectionTarget(worker,'other'),undefined);
});

test('initial and polling snapshots must keep session, project, canonical task and role ownership',()=>{
 const expected=workerInspectionTarget(worker,'project')!,original=snapshot();
 assert.equal(matchesSpecialistInspection(original,expected),true);
 assert.deepEqual(snapshotInspectionTarget(original),expected);
 for(const next of [
  {...original,session:{...original.session,id:'other'}},
  {...original,session:{...original.session,projectId:'other'}},
  {...original,session:{...original.session,workspaceRole:'role' as const}},
  {...original,superagent:{...original.superagent!,roleId:'other'}},
  {...original,superagent:{...original.superagent!,task:{...worker.task,taskId:'other'}}},
  {...original,superagent:{...original.superagent!,task:{...worker.task,sessionId:'other'}}},
  {...original,superagent:{...original.superagent!,task:{...worker.task,projectId:'other'}}},
 ])assert.equal(matchesSpecialistInspection(next,expected),false);
 assert.equal(matchesSpecialistInspection({...original,ai:{...original.ai!,rootTurnId:'real-sdk-root'}},expected),true,'a task inspection never equates task origin with the live SDK root');
 const pilot={...original,session:{...original.session,workspaceRole:'router' as const},superagent:{...original.superagent!,roleId:'pilot:project'}};
 assert.equal(matchesSpecialistInspection(pilot,{...expected,roleId:'pilot:project'}),true);
 assert.equal(matchesSpecialistInspection({...pilot,superagent:{...pilot.superagent,roleId:'role'}},expected),false,'ordinary specialists cannot borrow a router session');
});

test('completed tasks can explicitly open execution while a missing goal still resolves the exact canonical records',()=>{
 const saved=snapshot(),selection={...latestInspectorSelection(saved,'execution'),followLatest:false};
 assert.deepEqual(selection,{sessionId:worker.sessionId,canonicalGoalId:worker.task.taskId,tab:'execution',followLatest:false});
 assert.equal(saved.superagent?.goal,undefined);
 assert.equal(inspectedCanonicalTask(saved,selection),saved.superagent!.task);
 assert.equal(inspectedCanonicalTask(saved,{...selection,sessionId:'another-worker'}),undefined);
 assert.equal(inspectedCanonicalTask(saved,{...selection,canonicalGoalId:'new-task'}),undefined);
 assert.equal(inspectedCanonicalTask({...saved,superagent:{...saved.superagent!,task:{...worker.task,projectId:'another-project'}}},selection),undefined);
});

test('returning from a specialist to a completed Pilot history keeps its exact execution tab',()=>{
 const pilot={...worker,id:'pilot-old',roleId:'pilot:project',sessionId:'pilot-session',task:{...worker.task,taskId:'pilot-old-task',sessionId:'pilot-session'}};
 const newer={...pilot,id:'pilot-new',task:{...pilot.task,taskId:'pilot-new-task'}};
 const selection={sessionId:pilot.sessionId,canonicalGoalId:pilot.task.taskId,tab:'execution' as const};
 const target=selectedRoleInspection(selection,[worker,newer,pilot]);
 assert.equal(target?.worker,pilot,'a newer Pilot result cannot replace the selected history');
 assert.equal(target?.tab,'execution','a completed summary cannot change the requested process tab');
 const saved={...snapshot(),session:{...snapshot().session,id:pilot.sessionId,workspaceRole:'router' as const},superagent:{roleId:pilot.roleId,task:pilot.task}};
 assert.equal(latestInspectorSelection(saved,target!.tab).tab,'execution');
 assert.equal(selectedRoleInspection({...selection,tab:'plan'},[pilot])?.tab,'plan');
 assert.equal(selectedRoleInspection({...selection,sessionId:worker.sessionId},[pilot]),undefined);
 assert.equal(selectedRoleInspection({...selection,followLatest:true},[pilot]),undefined);
});

test('out-of-order opening and refresh responses cannot overwrite a new target or reopen a closed inspector',async()=>{
 const guard=new InspectionRequestGuard(),committed:string[]=[];
 let resolveFirst!:(value:string)=>void;
 const first=guard.begin(),pending=new Promise<string>(resolve=>{resolveFirst=resolve;});
 const late=pending.then(value=>{if(first.current())committed.push(value);});
 const firstRefresh=guard.capture(),second=guard.begin();
 assert.equal(first.signal.aborted,true);assert.equal(first.current(),false);assert.equal(firstRefresh(),false);
 if(second.current())committed.push('second');
 resolveFirst('stale-first');await late;
 assert.deepEqual(committed,['second']);
 const refresh=guard.capture();guard.cancel();
 assert.equal(second.signal.aborted,true);assert.equal(second.current(),false);assert.equal(refresh(),false);
 const reopened=guard.begin();assert.equal(reopened.current(),true);assert.equal(refresh(),false,'reopening never revalidates a prior refresh');
 guard.cancel();assert.equal(reopened.current(),false);
});
