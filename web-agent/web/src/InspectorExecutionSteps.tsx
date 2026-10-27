import type {AgentRun,Resource,SRETask} from '../../shared/contracts';
import {Glyph,ResourceIcon} from './Icons';
import {inspectorProgress} from './InspectorTaskSummary';
import {inspectorAttempts} from './sessionInspectorModel';
import {sreRoles,sreStatus} from './sreTranscript';
import {DisclosureSummary} from './DisclosureSummary';

/** A view of the current plan; opening a step only selects its existing records. */
export function InspectorExecutionSteps({task,resources,runs,selectedId,onSelect}:{task:SRETask;resources:Resource[];runs?:AgentRun[];selectedId?:string;onSelect:(attemptId:string)=>void}){
 const {steps,completed}=inspectorProgress(task,runs),attempts=task.runs.at(-1)?.planRevisionId===task.plans.at(-1)?.id?inspectorAttempts(task):[];
 const scope=(task.plans.at(-1)?.scope??task.scope).map(id=>resources.find(resource=>resource.id===id)).filter((resource):resource is Resource=>!!resource);
 const finished=steps.filter(item=>item.status==='succeeded');
 const remaining=steps.filter(item=>item.status!=='succeeded');
 const renderStep=({step,status}:typeof steps[number])=>{
  const attempt=attempts.find(item=>item.step.id===step.id)?.attempt;
  return <li key={step.id} data-state={status} data-selected={!!attempt&&attempt.id===selectedId}>
   <span className="execution-step-dot" aria-hidden="true">{status==='succeeded'?<Glyph name="check" size={11}/>:['failed','unknown','interrupted'].includes(status)?<Glyph name="alert" size={12}/>:null}</span>
   <button type="button" disabled={!attempt} aria-label={`${step.description}，${sreStatus[status]??status}`} aria-current={attempt?.id===selectedId?'step':undefined} onClick={()=>attempt&&onSelect(attempt.id)}>
    <strong title={step.description}>{step.description}</strong>
    <span>{sreRoles[step.role].name}<i aria-hidden="true">·</i><em>{sreStatus[status]??status}</em></span>
   </button>
  </li>;
 };
 return <section className="inspector-execution-steps" aria-label="当前计划执行步骤">
  <h3><Glyph name="document" size={17}/>当前执行</h3>
  <div className="execution-scope">{scope.length===1?<><ResourceIcon kind={scope[0]!.kind} size={16}/><span title={scope[0]!.name}>{scope[0]!.name}</span></>:<><Glyph name="layers" size={16}/><span>{scope.length?`${scope.length} 个资源`:'任务步骤'}</span></>}<small>{completed} / {steps.length}</small></div>
  {remaining.length>0&&<ol>{remaining.map(renderStep)}</ol>}
  {finished.length>0&&<details className="execution-completed"><DisclosureSummary>已完成 · {finished.length} 项</DisclosureSummary><ol>{finished.map(renderStep)}</ol></details>}
 </section>;
}
