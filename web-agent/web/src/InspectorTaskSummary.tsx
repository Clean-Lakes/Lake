import type {AgentRun,SRETask} from '../../shared/contracts';
import {Glyph} from './Icons';
import {sreRoles,sreStatus,sreStepStatus} from './sreTranscript';

export function inspectorProgress(task:SRETask,runs:AgentRun[]=[]){
 const steps=(task.plans?.at(-1)?.steps??[]).map(step=>{
  let status=sreStepStatus(task,step,runs);
  if(['running','queued','waiting_input','waiting_approval'].includes(status)){
   if(task.status==='paused')status='paused';
   else if(['completed','failed','cancelled'].includes(task.status))status='interrupted';
  }
  return {step,status};
 });
 return {steps,completed:steps.filter(step=>step.status==='succeeded').length};
}

export function InspectorTaskSummary({task,title,runs}:{task:SRETask;title:string;runs?:AgentRun[]}){
 const {steps,completed}=inspectorProgress(task,runs),total=steps.length,done=total>0&&completed===total;
 const uncertain=steps.some(step=>step.status==='unknown');
 const result=uncertain?{tone:'attention',label:'执行结果待核实',detail:'保留原始记录，核实后再确认结果。'}
  :task.status==='completed'&&task.outcome==='inconclusive'?{tone:'attention',label:'结论不充分',detail:done?'步骤已执行完，仍有未确认项。':'仍有检查缺口，请查看步骤与证据。'}
  :task.status==='completed'&&task.recoveryStatus==='verified'?{tone:'success',label:'恢复已验证',detail:'独立验证已确认恢复结果。'}
  :task.status==='failed'?{tone:'danger',label:'检查未完成',detail:'已取得的证据和操作记录保留。'}:undefined;
 const phaseTone=['waiting_input','waiting_approval'].includes(task.status)?'attention':task.status==='active'?'active':task.status==='failed'?'danger':'neutral';
 return <section className="inspector-task-summary" aria-label="任务进度概览">
  <div className="inspector-summary-title"><strong title={task.plans?.at(-1)?.goal}>{title}</strong><span data-tone={phaseTone}>{sreStatus[task.status]??task.status}</span></div>
  {total>0?<><div className="inspector-progress-caption"><span>{done?'步骤全部完成':'步骤进度'}</span><span className="inspector-progress-count" data-complete={done} data-has-completed={completed>0}>{done&&<Glyph name="check" size={13}/>}<b>{completed}</b><span>/ {total} 步</span></span></div>
   <div className="inspector-step-segments" role="progressbar" aria-label="步骤完成进度" aria-valuemin={0} aria-valuemax={total} aria-valuenow={completed} aria-valuetext={`已完成 ${completed} / ${total} 步${result?'，'+result.label:''}`}>{steps.map(({step,status},index)=><i key={step.id} data-state={status} title={`${index+1}. ${sreRoles[step.role].name} · ${step.description} · ${sreStatus[status]??status}`}/>)}</div>
  </>:<p className="inspector-progress-empty">计划生成后显示步骤进度</p>}
  {result&&<div className="inspector-summary-result" data-tone={result.tone}><Glyph name={result.tone==='success'?'check':'alert'} size={14}/><div><strong>{result.label}</strong><p>{result.detail}</p></div></div>}
 </section>;
}
