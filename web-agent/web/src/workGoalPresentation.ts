import type {SessionSnapshot,WorkSession} from '../../shared/contracts';
export function workGoalPresentation(snapshot?:SessionSnapshot|null):{label?:string;status?:WorkSession['status']}|undefined{
 const goal=snapshot?.ai?.workGoals?.find(g=>g.originRootTurnId===snapshot.ai?.rootTurnId);
 if(!goal)return;
 switch(goal.status){
  case 'running':return {label:'正在推进工作目标',status:'investigating'};
  case 'waiting_external':return {label:'等待外部任务完成',status:'investigating'};
  case 'waiting_user':return {label:'工作目标等待用户确认',status:'waiting_approval'};
  case 'paused':return {label:'任务已暂停',status:'completed'};
  case 'cancelled':return {label:'任务已取消',status:'completed'};
  case 'blocked':return {label:'工作目标有待处理的阻塞',status:'failed'};
  case 'failed':return {label:'工作目标未完成',status:'failed'};
  case 'completed':return {label:'工作目标已完成',status:'completed'};
 }
}
