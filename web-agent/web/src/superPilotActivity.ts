import type {SuperWorker,SuperWorkerActivity,SuperWorkspace,WorkSession} from '../../shared/contracts';
import type {AvatarMotion} from './superAgentPresentation';

type ActiveWorker=SuperWorker&{activity:SuperWorkerActivity};
const priority:Record<SuperWorkerActivity['phase'],number>={waiting_approval:0,waiting_input:1,tool:2,thinking:3,waiting_external:4,queued:5};
const fallbackLabels:Record<SuperWorkerActivity['phase'],string>={waiting_approval:'等待确认',waiting_input:'等待你补充信息',tool:'正在执行操作',thinking:'正在分析',waiting_external:'等待外部结果',queued:'等待开始'};
const finished=new Set<SuperWorker['task']['state']>(['completed','failed','cancelled']);

export type SuperPilotActivity={
 status:WorkSession['status'];
 label:string;
 phase:SuperWorkerActivity['phase']|'finishing';
 animated:boolean;
 motion:AvatarMotion;
 workerCount:number;
};

// This is a view of live host activity, never an inference from a task's last
// status or report. Completing the Router reply does not complete its workers.
export function superPilotActivity(workspace:SuperWorkspace|null|undefined,session:Pick<WorkSession,'id'|'projectId'>|null|undefined,connected=true,presentedReports?:ReadonlySet<string>):SuperPilotActivity|null {
 if(!session||!workspace?.active||workspace.project.projectId!==session.projectId||workspace.project.routerSessionId!==session.id)return null;
 const scoped=workspace.workers.filter(worker=>worker.assignmentState!=='archived'&&worker.assignmentState!=='stopped'&&
  worker.task.sessionId===worker.sessionId&&(!worker.task.projectId||worker.task.projectId===session.projectId));
 const workers=scoped.filter((worker):worker is ActiveWorker=>!!worker.activity&&!finished.has(worker.task.state));
 if(!workers.length){
  const rounds=workspace.conversations?.filter(round=>round.projectId===session.projectId&&round.sessionId===session.id&&['queued','running','summarizing'].includes(round.state))??[];
  if(rounds.length){
   const count=rounds.reduce((sum,round)=>sum+round.members.filter(member=>['queued','running'].includes(member.state)).length,0);
   return {status:connected?'investigating':'idle',label:connected?rounds.some(round=>round.state==='summarizing')?'Pilot 正在汇总专员回应':`${count} 位专员尚未回应`:'进度暂未更新，正在重连',phase:'thinking',animated:connected,motion:connected?'working':'still',workerCount:count};
  }
  const closing=presentedReports&&scoped.filter(worker=>worker.task.state==='completed'&&worker.pilotReport&&
   (!worker.pilotReport.executionSettled||!presentedReports.has(worker.pilotReport.messageId)));
  if(!closing?.length)return null;
  return {status:connected?'investigating':'idle',label:connected?'正在收尾专员回复':'进度暂未更新，正在重连',
   phase:'finishing',animated:connected,motion:connected?'working':'still',workerCount:closing.length};
 }
 workers.sort((a,b)=>priority[a.activity.phase]-priority[b.activity.phase]||b.activity.updatedAt.localeCompare(a.activity.updatedAt)||a.sessionId.localeCompare(b.sessionId));
 const phase=workers[0].activity.phase;
 if(!connected)return {status:'idle',label:'进度暂未更新，正在重连',phase,animated:false,motion:'still',workerCount:workers.length};
 const animated=phase==='thinking'||phase==='tool';
 const waiting=phase==='waiting_approval'||phase==='waiting_input';
 // The badge keeps its compact shared label; its tooltip names the specialists
 // and their current safe activity labels. Never copy historical step reasons.
 const descriptions=workers.slice(0,4).map(worker=>`${worker.roleName}：${worker.activity.label.trim()||fallbackLabels[worker.activity.phase]}`);
 if(workers.length>descriptions.length)descriptions.push(`另有 ${workers.length-descriptions.length} 位专员`);
 return {status:waiting?'waiting_approval':animated?'investigating':'idle',label:descriptions.join('；'),phase,
  animated,motion:animated?'working':'still',workerCount:workers.length};
}
