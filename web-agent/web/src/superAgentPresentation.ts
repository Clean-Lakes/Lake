import type {SuperTask,SuperWorker} from '../../shared/contracts';
import type {AgentIconName} from './AgentIcon';
import {lakeAvatarGroups} from './lakeAvatarCatalog';

const specialistPalettes=['river','moss','reed','clay'] as const;
export function superWorkerAppearance(worker:Pick<SuperWorker,'roleName'>&{roleId?:string}) {
 // RoleID owns the appearance. Names only support older servers without IDs.
 const identity=worker.roleId||worker.roleName.normalize('NFKC').trim().toLowerCase();
 let seed=2166136261;
 for(const char of identity)seed=Math.imul(seed^char.codePointAt(0)!,16777619)>>>0;
 const group=lakeAvatarGroups[seed%lakeAvatarGroups.length];
 return {icon:group.avatars[(seed>>>16)%group.avatars.length].id,palette:specialistPalettes[(seed>>>8)%4],variant:(seed>>>12)%3,phase:-(seed%7600)};
}
export function superWorkerIcon(worker:Pick<SuperWorker,'roleName'>&{roleId?:string}):AgentIconName {return superWorkerAppearance(worker).icon;}

export type AvatarMotion='idle'|'working'|'still';
export function superAvatarMotion(running:boolean,state?:SuperTask['state']):AvatarMotion {
 if(running)return 'working';
 return state&&['paused','blocked','failed','cancelled'].includes(state)?'still':'idle';
}

const labels:Record<SuperTask['state'],string>={queued:'排队中',running:'执行中',waiting_external:'等待外部结果',waiting_user:'需要你回答',paused:'已暂停',blocked:'待核实',completed:'执行结束',failed:'执行失败',cancelled:'已停止跟进'};
export function superTaskPresentation(task:Pick<SuperTask,'state'|'acceptanceState'>):{label:string;tone:'active'|'attention'|'danger'|'neutral'|'success'} {
 if(task.state==='completed')return task.acceptanceState==='pass'?{label:'已验收',tone:'success'}:{label:task.acceptanceState==='fail'?'验收未通过':'待验收',tone:'attention'};
 const tone=task.state==='running'||task.state==='waiting_external'?'active':task.state==='waiting_user'||task.state==='blocked'?'attention':task.state==='failed'?'danger':'neutral';
 return {label:labels[task.state]??'待核实',tone};
}

// A restored invocation can have ended while its canonical task is paused.
export function superTaskHeaderPresentation(task?:SuperTask) {
 if(task?.state==='blocked'&&task.reason==='token_limit_removed')return {status:'failed' as const,label:'等待后续核对'};
 return task?.state==='paused'?{status:'completed' as const,label:'任务已暂停'}:undefined;
}
