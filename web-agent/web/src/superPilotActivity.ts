import type {SuperWorker,SuperWorkerActivity,SuperWorkspace,WorkSession} from '../../shared/contracts';
import type {AvatarMotion} from './superAgentPresentation';
import type {SpecialistTaskMember} from './specialistTaskListModel';

type ActiveWorker=SuperWorker&{activity:SuperWorkerActivity};
const priority:Record<SuperWorkerActivity['phase'],number>={waiting_approval:0,waiting_input:1,tool:2,thinking:3,waiting_external:4,queued:5};
const fallbackLabels:Record<SuperWorkerActivity['phase'],string>={waiting_approval:'等待确认',waiting_input:'等待你补充信息',tool:'正在执行操作',thinking:'正在分析',waiting_external:'等待外部结果',queued:'等待开始'};
const finished=new Set<SuperWorker['task']['state']>(['completed','failed','cancelled']);

export type SuperPilotActivity={
 status:WorkSession['status'];
 label:string;
 idleLabel?:string;
 activeLabel?:string;
 phase:SuperWorkerActivity['phase']|'finishing'|'summarizing';
 animated:boolean;
 motion:AvatarMotion;
 workerCount:number;
 participants:PilotParticipant[];
};
export type PilotParticipant=SpecialistTaskMember&{detail:string};

function reconnecting(phase:SuperPilotActivity['phase'],workerCount:number,participants:PilotParticipant[]):SuperPilotActivity {
 return {status:'idle',label:'进度暂未更新，正在重连',idleLabel:'重连中',phase,animated:false,motion:'still',workerCount,participants};
}

function activityLabel(activity:SuperWorkerActivity) {
 return activity.label.trim()||fallbackLabels[activity.phase];
}

// This is a view of live host activity, never an inference from a task's last
// status or report. Completing the Router reply does not complete its workers.
export function superPilotActivity(workspace:SuperWorkspace|null|undefined,session:Pick<WorkSession,'id'|'projectId'>|null|undefined,connected=true,presentedReports?:ReadonlySet<string>):SuperPilotActivity|null {
 if(!session||!workspace?.active||workspace.project.projectId!==session.projectId||workspace.project.routerSessionId!==session.id)return null;
 const scoped=workspace.workers.filter(worker=>!worker.parentWorkerId&&worker.assignmentState!=='archived'&&worker.assignmentState!=='stopped'&&
  worker.task.sessionId===worker.sessionId&&(!worker.task.projectId||worker.task.projectId===session.projectId));
 const workers=scoped.filter((worker):worker is ActiveWorker=>!!worker.activity&&!finished.has(worker.task.state));
 const rounds=workspace.conversations?.filter(round=>round.projectId===session.projectId&&round.sessionId===session.id&&['queued','running','summarizing'].includes(round.state))??[];
 const roundMembers=rounds.flatMap(round=>round.members.filter(member=>['queued','running'].includes(member.state)));
 const closing=presentedReports?scoped.filter(worker=>worker.task.state==='completed'&&worker.pilotReport&&
   (!worker.pilotReport.executionSettled||!presentedReports.has(worker.pilotReport.messageId))):[];
 const people=new Map<string,PilotParticipant>();
 const add=(roleId:string,name:string,detail:string,moving:boolean)=>{
  if(!roleId||roleId==='pilot')return;
  const active=connected&&moving,previous=people.get(roleId);
  if(!previous||active&&!previous.moving)people.set(roleId,{key:roleId,roleId,name,detail:connected?detail:'等待重新连接',moving:active});
 };
 for(const worker of workers)add(worker.roleId,worker.roleName,activityLabel(worker.activity),['thinking','tool'].includes(worker.activity.phase));
 for(const worker of closing)add(worker.roleId,worker.roleName,'正在提交报告',true);
 for(const member of roundMembers)add(member.roleId,member.roleName,member.state==='running'?'正在回应':'等待回应',member.state==='running');
 const participants=[...people.values()].sort((a,b)=>a.key.localeCompare(b.key));
 if(!workers.length){
  if(rounds.length){
   const count=roundMembers.length;
   const summarizing=rounds.some(round=>round.state==='summarizing');
   if(!connected)return reconnecting('thinking',count,participants);
   return {status:'investigating',label:summarizing?'Pilot 正在汇总专员回应':`${count} 位专员尚未回应`,
    activeLabel:summarizing?'汇总中':undefined,phase:summarizing?'summarizing':'thinking',animated:true,motion:'working',workerCount:count,participants};
  }
  if(!closing.length)return null;
  if(!connected)return reconnecting('finishing',closing.length,participants);
  return {status:'investigating',label:'正在收尾专员回复',activeLabel:'收尾中',phase:'finishing',animated:true,motion:'working',workerCount:closing.length,participants};
 }
 workers.sort((a,b)=>priority[a.activity.phase]-priority[b.activity.phase]||b.activity.updatedAt.localeCompare(a.activity.updatedAt)||a.sessionId.localeCompare(b.sessionId));
 const phase=workers[0].activity.phase;
 if(!connected)return reconnecting(phase,workers.length,participants);
 const animated=phase==='thinking'||phase==='tool';
 const waiting=phase==='waiting_approval'||phase==='waiting_input';
 const descriptions=workers.slice(0,4).map(worker=>`${worker.roleName}：${activityLabel(worker.activity)}`);
 if(workers.length>descriptions.length)descriptions.push(`另有 ${workers.length-descriptions.length} 位专员`);
 return {status:waiting?'waiting_approval':animated?'investigating':'idle',label:descriptions.join('；'),phase,
  idleLabel:phase==='queued'||phase==='waiting_external'?activityLabel(workers[0].activity):undefined,
  animated,motion:animated?'working':'still',workerCount:workers.length,participants};
}
