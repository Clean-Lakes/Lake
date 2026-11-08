import type {Message,SpecialistReplyAuthor,SuperWorker,SuperWorkspace} from '../../shared/contracts';
import {Glyph} from './Icons';
import {LoadingWaves} from './LoadingWaves';
import {StatusText} from './StatusText';
import {usePageVisible} from './usePageVisible';

type Activity=NonNullable<SuperWorker['activity']>;
export type PilotDispatchRow={worker:SuperWorker;activity:Activity;sourceMessageId:string;author:SpecialistReplyAuthor};

/** A live projection of committed dispatches, never another transcript message. */
export function pilotDispatchRows(workspace:SuperWorkspace|null|undefined,sessionId:string,messages:Message[]):PilotDispatchRow[]{
 if(!workspace?.active||workspace.project.routerSessionId!==sessionId)return [];
 const newestMessages=[...messages].reverse();
 const userIds=new Set(messages.filter(message=>message.role==='user').map(message=>message.id));
 return workspace.workers.flatMap(worker=>{
  if(worker.task.sessionId!==worker.sessionId||worker.task.projectId&&worker.task.projectId!==workspace.project.projectId)return [];
  if(['archived','stopped'].includes(worker.assignmentState)||['completed','failed','cancelled'].includes(worker.task.state))return [];
  const activity=worker.activity;
  if(!activity)return [];
  if(activity.sourceSessionId&&activity.sourceSessionId!==sessionId)return [];
  const dispatch=newestMessages.find(message=>message.dispatch?.workerId===worker.id&&message.dispatch.taskId===worker.task.taskId&&message.dispatch.roleId===worker.roleId&&message.dispatch.sessionId===worker.sessionId)?.dispatch;
  const source=activity.sourceSessionId===sessionId?activity.sourceMessageId:undefined;
  if(!source&&!dispatch)return [];
  const sourceMessageId=source??dispatch!.sourceMessageId;
  if(!userIds.has(sourceMessageId))return [];
  const channel=workspace.channels?.find(item=>item.roleId===worker.roleId);
  return [{worker,activity,sourceMessageId,
   author:{kind:'specialist',name:worker.roleName,roleId:worker.roleId,workerId:worker.id,sessionId:worker.sessionId,taskId:worker.task.taskId,
    channelSessionId:channel?.sessionId??dispatch?.channelSessionId}}];
 });
}

export function PilotDispatchProgress({rows,onSpecialist,connected=true}:{rows:PilotDispatchRow[];onSpecialist?:(author:SpecialistReplyAuthor)=>void;connected?:boolean}){
 const visible=usePageVisible();
 if(!rows.length)return null;
 return <div className="pilot-dispatch-progress" role="status" aria-live="polite" aria-atomic="false" aria-label="专员工作进展">
  {rows.map(({worker,activity,author})=>{
   const moving=connected&&['thinking','tool'].includes(activity.phase);
   const label=connected?activity.label:'进度暂未更新，正在重连';
   const description=`${worker.roleName} · ${label}：${worker.task.title}`;
   const mark=activity.phase==='waiting_approval'?'shield':activity.phase==='waiting_input'?'chat':'clock';
   return <button type="button" key={worker.id} className="pilot-dispatch-progress-row" data-worker-id={worker.id} data-task-id={worker.task.taskId} data-phase={activity.phase}
    title={description} aria-label={`${description}，查看专员进展`} onClick={()=>onSpecialist?.(author)} disabled={!onSpecialist}>
    {moving?<LoadingWaves/>:<span className="turn-status-mark" aria-hidden="true"><Glyph name={mark} size={18}/></span>}
    <StatusText active={moving&&visible} className="pilot-dispatch-progress-text">{description}</StatusText>
    <Glyph name="next" size={12} className="pilot-dispatch-progress-chevron"/>
   </button>;
  })}
 </div>;
}
