import {useRef} from 'react';
import type {Message,SuperWorkspace,WorkSession} from '../../shared/contracts';
import {AssistantMarkdown} from './AssistantMarkdown';
import {DisclosureSummary} from './DisclosureSummary';
import {HeaderSweep} from './HeaderSweep';
import {Glyph} from './Icons';
import {SuperRoleAvatar} from './SuperRoleAvatar';
import {superTaskPresentation} from './superAgentPresentation';
import type {InspectSpecialist} from './SessionInspectorContext';
import {latestPilotTaskAssignments,pilotExecutionSteps} from './pilotExecutionOverviewModel';
import type {PilotSummarySlot} from './routeDispatchPresentation';
import type {TranscriptEntry} from './timeline';

export function PilotExecutionOverview({workspace,session,source,messages,turn,summaries,active,onInspect}:{
 workspace?:SuperWorkspace|null;session:Pick<WorkSession,'id'|'projectId'>;turn:readonly TranscriptEntry[];
 source?:Message;messages:readonly Message[];summaries:readonly PilotSummarySlot[];active:boolean;onInspect?:InspectSpecialist;
}){
 const assignments=latestPilotTaskAssignments(workspace,session,source,messages);
 const task=assignments[0]?.worker.task;
 const taskState=task?.collaboration??task;
 const status=taskState?superTaskPresentation(taskState):undefined;
 const complete=taskState?.state==='completed';
 const steps=pilotExecutionSteps(turn,source,summaries,messages);
 const current=active?steps.filter(step=>step.running).at(-1)?.id:undefined;
 const animated=useRef(current);
 if(current)animated.current=current;
 return <div className="pilot-execution-overview">
  {task&&status&&<header className="pilot-execution-task">
   <div><small>最新任务</small><span className="pilot-execution-state" data-tone={complete?'success':status.tone}>
    {complete&&<span className="pilot-status-mark" data-ring aria-hidden="true"><Glyph name="check" size={10}/></span>}{status.label}
   </span></div>
   <h3>{task.title}</h3>
  </header>}
  <section className="pilot-execution-workers" aria-label="Worker 详情">
   <div className="pilot-execution-section-heading"><h3>Worker 详情</h3>{assignments.length>0&&<small>{assignments.length} 位专员</small>}</div>
   {assignments.length?<div className="pilot-execution-worker-list" key={task?.taskId}>
    {assignments.map(({worker,instruction,report})=>{
     const channel=workspace?.channels?.find(channel=>channel.roleId===worker.roleId);
     const state=report?{label:worker.task.reportedOutcome==='partial'?'部分回传':'已回传',tone:'success'}:superTaskPresentation(worker.task);
     return <details key={worker.id}>
      <DisclosureSummary className="pilot-execution-worker-summary">
       <SuperRoleAvatar roleId={worker.roleId} name={worker.roleName} avatarId={channel?.avatarId} size={22} motion="still"/>
       <strong>{worker.roleName}</strong><span className="pilot-execution-state" data-tone={state.tone}>{report&&<Glyph name="check" size={12}/>} {state.label}</span>
      </DisclosureSummary>
      <div className="pilot-execution-worker-detail">
       {instruction&&<p><small>负责</small> {instruction}</p>}
       {report?.text.trim()&&<><small>回传</small><AssistantMarkdown allowImages={false}>{report.text}</AssistantMarkdown></>}
       {onInspect&&<button type="button" className="button secondary" onClick={()=>onInspect({
        kind:'specialist',name:worker.roleName,roleId:worker.roleId,workerId:worker.id,
        sessionId:worker.sessionId,taskId:worker.task.taskId,channelSessionId:channel?.sessionId,execution:worker.execution?.backend,
       })}>查看 Worker 执行记录<Glyph name="next" size={12}/></button>}
      </div>
     </details>;
    })}
   </div>:<p className="inspector-empty">本轮尚无关联 Worker。</p>}
  </section>
  <section className="pilot-execution-steps" aria-label="Pilot 操作过程">
   <div className="pilot-execution-section-heading"><SuperRoleAvatar pilot size={18} motion="still"/><h3>Pilot 操作过程</h3></div>
   {steps.length?<ol>{steps.map(step=><li key={step.id}>
    <span className="pilot-execution-step-icon"><Glyph name={step.icon} size={15}/></span>
    <div className="pilot-execution-step-content">
     <span className="pilot-execution-step-name" data-active={step.id===current||undefined}>
      {step.id===animated.current&&<HeaderSweep active={step.id===current}/>}
      <span>{step.label}</span>
     </span>
     {step.description&&<p>{step.description}</p>}
    </div>
    {step.status&&<small>{step.status}</small>}
   </li>)}</ol>:<p className="inspector-empty">本轮尚无 Pilot 操作记录。</p>}
  </section>
 </div>;
}
