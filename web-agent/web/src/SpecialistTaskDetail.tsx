import {useId,useState,type ReactNode} from 'react';
import type {SessionSnapshot,SuperWorker} from '../../shared/contracts';
import {ObjectReferencesProvider} from './AssistantMarkdown';
import {Glyph} from './Icons';
import {SpecialistTaskControls} from './SpecialistTaskControls';
import {SpecialistTaskMetadata,SpecialistTaskSteps} from './SpecialistTaskList';
import {SuperTaskInspector} from './SuperTaskInspector';
import {TabSelectionIndicator} from './TabSelectionIndicator';
import {TaskWatchdog} from './TaskWatchdog';
import {WorkerExecutionResults,WorkerExecutionTree} from './WorkerExecutionTree';
import {inspectorGoal} from './sessionInspectorModel';

const tabs=[{id:'results',label:'结果与证据'},{id:'execution',label:'执行过程'}] as const;
type TaskTab=typeof tabs[number]['id'];

export function SpecialistTaskDetail({snapshot,worker,connected,onBack,onContinue,onUpdated,resultsFooter}:{
 snapshot:SessionSnapshot;
 worker?:SuperWorker;
 connected:boolean;
 onBack?:()=>void;
 onContinue?:()=>void;
 onUpdated:()=>void;
 resultsFooter?:ReactNode;
}) {
 const id=useId();
 const task=snapshot.superagent?.task;
 const goal=inspectorGoal(snapshot,task?.taskId);
 const watchdog=snapshot.superagent?.watchdog;
 const readOnly=snapshot.session.workspaceRole==='legacy'||worker?.assignmentState==='archived';
 const actionable=connected&&!readOnly;
 const [selected,setSelected]=useState<TaskTab>(()=>task?.summary&&!['running','queued','waiting_external','waiting_user'].includes(task.state)?'results':'execution');

 return <article className="timeline-list specialist-task-detail" aria-label="任务详情" tabIndex={-1}>
  <header className="specialist-task-detail-header">
   {onBack&&<button type="button" className="specialist-task-back" onClick={onBack}><Glyph name="previous" size={14}/>全部任务</button>}
   <h1>{task?.title??snapshot.session.title}</h1>
   {task&&goal&&<SuperTaskInspector task={task} goal={goal} worker={worker} summaryOnly hideTitle hideStatus/>}
   <SpecialistTaskMetadata snapshot={snapshot} worker={worker}/>
  </header>
  <ObjectReferencesProvider resources={snapshot.resources} tasks={snapshot.ai?.agentRuns}>
   {!readOnly&&<SpecialistTaskControls snapshot={snapshot} connected={actionable}/>}
   <div className="session-inspector-tabs specialist-task-detail-tabs" role="tablist" aria-label="任务视图" onKeyDown={event=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    event.preventDefault();
    const target=event.key==='Home'?'results':event.key==='End'?'execution':selected==='results'?'execution':'results';
    setSelected(target);
    document.getElementById(`${id}-${target}-tab`)?.focus();
   }}>
    {tabs.map(tab=><button type="button" role="tab" key={tab.id} id={`${id}-${tab.id}-tab`} aria-selected={selected===tab.id}
     aria-controls={`${id}-${tab.id}-panel`} tabIndex={selected===tab.id?0:-1} onClick={()=>setSelected(tab.id)}>{tab.label}</button>)}
    <TabSelectionIndicator selection={selected}/>
   </div>
   <div className="specialist-task-detail-panel" role="tabpanel" id={`${id}-results-panel`} aria-labelledby={`${id}-results-tab`} hidden={selected!=='results'}>
    <WorkerExecutionResults snapshot={snapshot} readMarker={selected==='results'?resultsFooter:undefined}/>
    {task&&goal&&<SuperTaskInspector task={task} goal={goal} worker={worker} plan hideHeading foldSteps/>}
   </div>
   <div className="specialist-task-detail-panel" role="tabpanel" id={`${id}-execution-panel`} aria-labelledby={`${id}-execution-tab`} hidden={selected!=='execution'}>
    <SpecialistTaskSteps snapshot={snapshot} worker={worker} connected={actionable}/>
    <WorkerExecutionTree snapshot={snapshot} worker={worker} connected={actionable} onUpdated={onUpdated}/>
    {task&&goal&&!readOnly&&<SuperTaskInspector task={task} goal={goal} worker={worker} controlsOnly connected={actionable} onUpdated={onUpdated}/>}
    {goal&&watchdog&&<TaskWatchdog view={watchdog}/>}
   </div>
  </ObjectReferencesProvider>
  {onContinue&&<footer className="specialist-task-detail-actions"><button type="button" className="button secondary" onClick={onContinue}>前往 Pilot 继续沟通<Glyph name="arrow" size={14}/></button></footer>}
 </article>;
}
