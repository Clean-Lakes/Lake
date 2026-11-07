import {SuperTaskInspector} from './SuperTaskInspector';
import {TaskWatchdog} from './TaskWatchdog';
import {OperationReconciliation} from './OperationReconciliation';
import {WorkerExecutionTree,WorkerExecutionResults} from './WorkerExecutionTree';
import {InspectorTaskSummary} from './InspectorTaskSummary';
import {useEffect,useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import type {SessionSnapshot,SRETranscriptEntry,SuperWorker} from '../../shared/contracts';
import {AgentIcon} from './AgentIcon';
import {Glyph} from './Icons';
import {InspectorExecutionSteps} from './InspectorExecutionSteps';
import {DisclosureSummary} from './DisclosureSummary';
import {ObjectReferencesProvider} from './AssistantMarkdown';
import {SREPlanCard} from './SREPlanCard';
import {SRERoleMessage} from './SRERoleMessage';
import {sreRoles,sreStatus,sreStepStatus} from './sreTranscript';
import {inspectorGoal,hasInspectorTask,inspectedTask,inspectedAttempt,inspectorAttempts,resolvedInspectorSelection} from './sessionInspectorModel';
import {sessionInspectorId,useSessionInspector,type InspectorSelection} from './SessionInspectorContext';

export function SessionInspector({snapshot,connected,onUpdated,worker,readOnly=false,taskNavigation}:{snapshot:SessionSnapshot;connected:boolean;onUpdated:()=>void;worker?:SuperWorker;readOnly?:boolean;taskNavigation?:ReactNode}){
 readOnly=readOnly||snapshot.session.workspaceRole==='legacy';
 const inspector=useSessionInspector()!;
 const selection=resolvedInspectorSelection(snapshot,inspector.selection);
 const retained=useRef<InspectorSelection|null>(selection);
 if(selection)retained.current=selection;
 const [present,setPresent]=useState(!!selection),panel=useRef<HTMLElement>(null);
 useEffect(()=>{
  if(selection){setPresent(true);return;}
  const timer=setTimeout(()=>setPresent(false),window.matchMedia('(prefers-reduced-motion: reduce)').matches?0:180);
  return()=>clearTimeout(timer);
 },[!!selection]);
 const target=selection??retained.current;
 const followTurn=selection?.followLatest?snapshot.messages?.filter(message=>message.role==='user').at(-1)?.id:undefined;
 useLayoutEffect(()=>{const scroll=panel.current?.querySelector('.session-inspector-scroll');if(scroll)scroll.scrollTop=0;},[selection?.sessionId,selection?.turnId,selection?.taskId,selection?.canonicalGoalId,followTurn]);
 const task=target?inspectedTask(snapshot,target):undefined;
 const plan=task?.plans?.at(-1);
 const canonical=snapshot.superagent?.task;
 const goal=inspectorGoal(snapshot,target?.canonicalGoalId);
 const hasPlan=!!plan||!!goal?.items?.length;
 const selected=task?inspectedAttempt(task,target?.attemptId):undefined;
 useLayoutEffect(()=>{
  if(selection&&!selection.automatic&&panel.current&&!panel.current.contains(document.activeElement))panel.current.focus({preventScroll:true});
 },[inspector.selection]);
 if((!present&&!selection)||!target||target.sessionId!==snapshot.session.id)return null;
 const currentEntry=selected&&task?(task.messages?.find(entry=>entry.attemptId===selected.attempt.id&&entry.kind==='progress')??task.messages?.find(entry=>entry.attemptId===selected.attempt.id)??{id:`inspector-${selected.attempt.id}`,sessionId:task.sessionId,taskId:task.id,roleId:selected.step.role,roleRunId:selected.attempt.roleRunId,attemptId:selected.attempt.id,kind:'progress',body:'',source:'runtime',sequence:0,revision:0,createdAt:selected.attempt.startedAt} satisfies SRETranscriptEntry):undefined;
 const attemptStatus=selected&&task?(selected.attempt.planRunId===task.runs?.at(-1)?.id?sreStepStatus(task,selected.step,snapshot.ai?.agentRuns):selected.attempt.status):'';
 const activeTab=hasPlan||goal?target.tab:'execution';
 const choose=(tab:'plan'|'execution',attemptId=target.attemptId,pin=false)=>inspector.open({...target,tab,attemptId,followLatest:pin?false:target.followLatest,evidenceId:undefined,automatic:false});
 const tabs=<div className="session-inspector-tabs" role="tablist" aria-label="任务视图" onKeyDown={event=>{if((hasPlan||goal)&&['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();choose(event.key==='Home'?'plan':event.key==='End'?'execution':activeTab==='plan'?'execution':'plan');requestAnimationFrame(()=>panel.current?.querySelector<HTMLButtonElement>('[role=tab][aria-selected=true]')?.focus());}}}>
  <button type="button" role="tab" id="inspector-plan-tab" aria-selected={activeTab==='plan'} aria-controls="inspector-plan-panel" tabIndex={activeTab==='plan'?0:-1} disabled={!hasPlan&&!goal} title={!hasPlan&&!goal?'暂无最新计划':undefined} onClick={()=>choose('plan')}>{goal?'结果与证据':'计划'}</button>
  <button type="button" role="tab" id="inspector-execution-tab" aria-selected={activeTab==='execution'} aria-controls="inspector-execution-panel" tabIndex={activeTab==='execution'?0:-1} onClick={()=>choose('execution')}>{goal?'执行过程':'执行'}</button>
 </div>;
 return <aside ref={panel} id={sessionInspectorId} tabIndex={-1} className={`session-inspector${selection?' is-open':' is-closing'}`} inert={!selection} aria-hidden={!selection} aria-label="任务检查" onKeyDown={event=>{if(event.key==='Escape'&&!event.defaultPrevented){event.preventDefault();event.stopPropagation();inspector.close();}}}>
  <div className="session-inspector-card">
   <header className="session-inspector-heading"><Glyph name="document" size={17}/>{goal?<strong className="worker-inspector-title">任务详情</strong>:tabs}<button type="button" className="icon-button" aria-label="关闭任务检查" onClick={inspector.close}><Glyph name="close" size={16}/></button></header>
  <ObjectReferencesProvider resources={snapshot.resources} tasks={snapshot.ai?.agentRuns}>
   <div className="session-inspector-scroll">
    {taskNavigation}
    {goal&&canonical&&<><SuperTaskInspector task={canonical} goal={goal} worker={worker} summaryOnly/>{tabs}</>}
    {task&&activeTab==='plan'&&<InspectorTaskSummary task={task} title={snapshot.session.title} runs={snapshot.ai?.agentRuns}/>}
    <div role="tabpanel" id="inspector-plan-panel" aria-labelledby="inspector-plan-tab" hidden={activeTab!=='plan'}>
     {task&&plan?<SREPlanCard task={task} resources={snapshot.resources} agentRuns={snapshot.ai?.agentRuns} enabled={connected&&!readOnly&&snapshot.sre?.enabled===true} onUpdated={onUpdated} inspector onInspectStep={stepId=>{const attempt=inspectorAttempts(task).find(item=>item.step.id===stepId)?.attempt;if(attempt)choose('execution',attempt.id,true);}}/>:goal&&canonical?<><WorkerExecutionResults snapshot={snapshot}/><SuperTaskInspector task={canonical} goal={goal} worker={worker} plan hideHeading/></>:<p className="inspector-empty">计划生成后会显示在这里。</p>}
     {activeTab==='plan'&&goal&&canonical&&!readOnly&&<OperationReconciliation
       key={JSON.stringify([snapshot.session.projectId,snapshot.session.id,goal.id])}
       snapshot={snapshot} executionId={goal.id} connected={connected} onUpdated={onUpdated}/>}
    </div>
    <div role="tabpanel" id="inspector-execution-panel" aria-labelledby="inspector-execution-tab" hidden={activeTab!=='execution'}>
     {task&&<>
      <InspectorTaskSummary compact task={task} title={snapshot.session.title} runs={snapshot.ai?.agentRuns}/>
      <InspectorExecutionSteps task={task} resources={snapshot.resources} runs={snapshot.ai?.agentRuns} selectedId={selected?.attempt.id} onSelect={attemptId=>{choose('execution',attemptId,true);requestAnimationFrame(()=>{const details=panel.current?.querySelector<HTMLDetailsElement>('.execution-step-records');if(details)details.open=true;});}}/>
      <details className="execution-step-records" open={!!target.attemptId}>
       <DisclosureSummary><span className="execution-records-label">步骤记录</span>{selected&&<span className="execution-records-description" title={selected.step.description}>{selected.step.description}</span>}</DisclosureSummary>
       {selected&&<div className="inspector-attempt-heading"><AgentIcon role={selected.step.role} size={18}/><strong>{sreRoles[selected.step.role].name}</strong><span>{sreStatus[attemptStatus]??attemptStatus}</span><p>{selected.step.description}</p></div>}
       {currentEntry?<SRERoleMessage key={`${task.id}:${currentEntry.attemptId}`} detailsOnly connected={connected&&!readOnly} task={task} entry={currentEntry} snapshot={snapshot} onUpdated={onUpdated} renderApproval={()=>null}/>:<p className="inspector-empty">本步骤尚无执行记录。</p>}
      </details>
     </>}
     {goal&&canonical&&<><WorkerExecutionTree snapshot={snapshot} worker={worker} connected={connected&&!readOnly} onUpdated={onUpdated}/><SuperTaskInspector task={canonical} goal={goal} worker={worker} controlsOnly connected={connected&&!readOnly} onUpdated={onUpdated}/></>}
     {goal && canonical && snapshot.superagent?.watchdog && <TaskWatchdog
       key={JSON.stringify([snapshot.session.projectId, snapshot.session.id, goal.id])}
       projectId={snapshot.session.projectId} view={snapshot.superagent.watchdog} connected={connected && !readOnly}
       onUpdated={onUpdated}/>}
     {!task&&!goal&&<h3 className="inspector-execution-title"><Glyph name="document" size={17}/>当前执行</h3>}
     {!hasInspectorTask(snapshot,target)&&!target.turnId&&(!target.followLatest||!(snapshot.messages?.length??0)&&!snapshot.ai?.cards.length)&&<p className="inspector-empty">本轮尚无执行记录。</p>}
     {!goal&&<div ref={inspector.setHost} className="inspector-turn-host"/>}
    </div>
   </div>
  </ObjectReferencesProvider>
  </div>
 </aside>;
}
