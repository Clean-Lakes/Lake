import type {AIView,SessionSnapshot,SuperTask,SuperWorker,TaskParticipant} from '../../shared/contracts';
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
export type ConversationActivity='running'|'waiting'|'idle';
export type ConversationAvatarActivity={sessionId:string;state:ConversationActivity};
// Live reply metadata wins over a canonical goal that may still be blocked.
export function conversationActivity(view?:AIView,fallbackStatus?:string):ConversationActivity {
 const status=view?.replyStatus||view?.status||fallbackStatus;
 if(view?.question||view?.pending||view?.pendingApprovals?.length||status==='waiting_approval'||status==='waiting_input')return 'waiting';
 return status==='running'||!view&&status==='investigating'?'running':'idle';
}
export function conversationAvatarMotion(activity:ConversationActivity,state?:SuperTask['state']):AvatarMotion {
 return activity==='waiting'?'still':superAvatarMotion(activity==='running',state);
}
export function superAvatarMotion(running:boolean,state?:SuperTask['state']):AvatarMotion {
 if(running)return 'working';
 return state&&['paused','blocked','failed','cancelled'].includes(state)?'still':'idle';
}

const labels:Record<SuperTask['state'],string>={queued:'排队中',running:'执行中',waiting_external:'等待外部结果',waiting_user:'需要你回答',paused:'已暂停',blocked:'待核实',completed:'执行结束',failed:'执行失败',cancelled:'已停止'};
export function superTaskPresentation(task:Pick<SuperTask,'state'|'acceptanceState'>):{label:string;tone:'active'|'attention'|'danger'|'neutral'|'success'} {
 if(task.state==='completed')return task.acceptanceState==='pass'?{label:'已验收',tone:'success'}:{label:task.acceptanceState==='fail'?'验收未通过':'待验收',tone:'attention'};
 const tone=task.state==='running'||task.state==='waiting_external'?'active':task.state==='waiting_user'||task.state==='blocked'?'attention':task.state==='failed'?'danger':'neutral';
 return {label:labels[task.state]??'待核实',tone};
}

export function participantPresentation(member:TaskParticipant):ReturnType<typeof superTaskPresentation> {
 if(member.contributed)return {label:'已提交',tone:'success'};
 if(member.state==='completed')return {label:'未提交',tone:'attention'};
 return superTaskPresentation({state:member.state,acceptanceState:'not_evaluated'});
}

export function channelTaskPresentation(task:SuperTask) {
 const member=task.collaboration?.participants.find(member=>member.sessionId===task.sessionId);
 return member?participantPresentation(member):superTaskPresentation(task);
}

// Live replies own the badge; canonical task state only applies to its exact
// conversation. A Router can still carry an older inline task after delegating.
export function superTaskHeaderPresentation(task:SuperTask|undefined,snapshot:Pick<SessionSnapshot,'session'|'ai'>|null|undefined) {
 if(!snapshot)return;
 const {session,ai}=snapshot;
 if(['router','role','worker'].includes(session.workspaceRole??'')) {
  const activity=conversationActivity(ai,session.status);
  if(activity==='running')return {status:'investigating' as const,label:'处理中'};
  if(activity==='waiting')return {status:'waiting_approval' as const,label:ai?.question?'等待你的选择':'等待确认'};
 }
 if(!task||task.projectId&&task.projectId!==session.projectId)return;
 if(session.workspaceRole==='router') {
  if(task.sessionId!==session.id||!ai?.rootTurnId||task.originRootTurnId!==ai.rootTurnId)return;
 } else if(session.workspaceRole!=='role'&&task.sessionId!==session.id)return;
 if(task?.state==='blocked'&&task.reason==='token_limit_removed')return {status:'failed' as const,label:'等待后续核对'};
 return task?.state==='paused'?{status:'completed' as const,label:'任务已暂停'}:undefined;
}

/** Aggregate role activity without pairing a stopped task with a sibling's spinner. */
export function specialistTaskActivity(workers:SuperWorker[]) {
 const recent=[...workers].sort((a,b)=>(Date.parse(b.task.updatedAt??b.createdAt??'')||0)-(Date.parse(a.task.updatedAt??a.createdAt??'')||0));
 const active=recent.filter(worker=>worker.assignmentState==='active'&&!['completed','failed','cancelled'].includes(worker.task.state));
 const waiting=active.filter(worker=>worker.activity&&['waiting_approval','waiting_input'].includes(worker.activity.phase));
 const running=active.filter(worker=>!waiting.includes(worker));
 const queued=recent.filter(worker=>worker.assignmentState==='queued'&&!['completed','failed','cancelled'].includes(worker.task.state));
 const worker=running[0]??waiting[0]??queued[0]??recent[0];
 const counts=[running.length&&`${running.length} 项执行中`,waiting.length&&`${waiting.length} 项待确认`,queued.length&&`${queued.length} 项排队`].filter(Boolean).join(' · ');
 const detail=active.length+queued.length>1?counts:worker?.task.title;
 return {worker,detail,runningCount:running.length,waitingCount:waiting.length,queuedCount:queued.length};
}

export function stopControlPresentation(role?:string,typescript=false,collaborating=false) {
 if(role==='router'&&typescript)return {label:'停止当前项目全部任务',shortLabel:'停止项目全部任务',title:'停止当前项目全部活动任务，保留历史和草稿'};
 if(role==='role')return {label:'停止该专员全部任务',shortLabel:'停止专员全部任务',title:'停止该专员全部活动任务；单独停止请进入对应任务详情'};
 if(role==='worker'&&collaborating)return {label:'停止本专员的执行',shortLabel:'停止本专员的执行',title:'其他专员会继续执行'};
 if(role==='worker')return {label:'停止当前任务',shortLabel:'停止当前任务',title:'仅停止当前任务，不影响同一专员的其他任务'};
 return {label:'停止本轮回复',shortLabel:'停止本轮',title:'停止本轮回复，保留草稿'};
}
