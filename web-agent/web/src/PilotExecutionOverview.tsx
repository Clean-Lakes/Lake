import {useRef} from 'react';
import {createPortal} from 'react-dom';
import type {Message,SuperWorkspace,WorkSession} from '../../shared/contracts';
import {AssistantMarkdown} from './AssistantMarkdown';
import {DisclosureSummary} from './DisclosureSummary';
import {HeaderSweep} from './HeaderSweep';
import {Glyph} from './Icons';
import {SuperRoleAvatar} from './SuperRoleAvatar';
import {superTaskPresentation} from './superAgentPresentation';
import {useSessionInspector,type InspectSpecialist} from './SessionInspectorContext';
import {latestPilotTaskAssignments,pilotExecutionSteps} from './pilotExecutionOverviewModel';
import type {PilotSummarySlot} from './routeDispatchPresentation';
import type {TranscriptEntry} from './timeline';

const stepClock=new Intl.DateTimeFormat('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});

export function PilotExecutionOverview({workspace,session,source,messages,turn,summaries,active,onInspect}:{
 workspace?:SuperWorkspace|null;session:Pick<WorkSession,'id'|'projectId'>;turn:readonly TranscriptEntry[];
 source?:Message;messages:readonly Message[];summaries:readonly PilotSummarySlot[];active:boolean;onInspect?:InspectSpecialist;
}){
 const summaryHost=useSessionInspector()?.summaryHost;
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
  {task&&status&&summaryHost&&createPortal(<>
   <span className="pilot-execution-state pilot-execution-task-status" data-tone={complete?'success':status.tone}>
    {complete&&<span className="pilot-status-mark" data-ring aria-hidden="true"><Glyph name="check" size={10}/></span>}{status.label}
   </span>
   <h3 className="pilot-execution-task-title" title={task.title}><span className="visually-hidden">最新任务 </span>{task.title}</h3>
  </>,summaryHost)}
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
   <div className="pilot-execution-section-heading"><h3>Pilot 操作过程</h3></div>
   {steps.length?<ol role="list">{steps.map(step=>{
    const isCurrent=step.id===current;
    const status=isCurrent?{label:'进行中',tone:'active'}:step.status;
    const at=Date.parse(step.at);
    const action=<>
     <span className="pilot-execution-step-name" data-active={isCurrent||undefined}>
      {step.id===animated.current&&<HeaderSweep active={isCurrent}/>}<span>{step.label}</span>
     </span>
     {status&&<small data-tone={status.tone}>{status.label}</small>}
    </>;
    return <li key={step.id} aria-current={isCurrent?'step':undefined}>
     {Number.isFinite(at)&&<time dateTime={step.at} title={new Date(at).toLocaleString('zh-CN')}>{stepClock.format(at)}</time>}
     <span className="pilot-execution-step-icon" aria-hidden="true" data-tone={status?.tone}><Glyph name={step.icon} size={14}/></span>
     {step.description?<details className="pilot-execution-step-content">
      <DisclosureSummary className="pilot-execution-step-line">{action}</DisclosureSummary>
      <p>{step.description}</p>
     </details>:<div className="pilot-execution-step-content pilot-execution-step-line">{action}</div>}
    </li>;
   })}</ol>:<p className="inspector-empty">本轮尚无 Pilot 操作记录。</p>}
  </section>
 </div>;
}
