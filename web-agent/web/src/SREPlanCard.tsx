import {DisclosureSummary} from './DisclosureSummary';
import {useState} from 'react';
import type {SRETask,Resource,AgentRun} from '../../shared/contracts';
import {Glyph} from './Icons';
import {api,readableError} from './api';
import {SREBlockers,sreUnresolvedOperations} from './SREBlockers';
import {displayAiError} from './aiErrors';
import {sreRoles,sreStatus,sreStepAttempt,sreTaskActive,sreCanStart,sreStepStatus} from './sreTranscript';

export function SREPlanCard({task,resources,onUpdated,enabled=true,agentRuns=[]}:{task:SRETask;resources:Resource[];agentRuns?:AgentRun[];onUpdated:()=>void;enabled?:boolean}){
 const plan=task.plans?.at(-1);const [busy,setBusy]=useState(false),[error,setError]=useState(''),[editing,setEditing]=useState(false),[goal,setGoal]=useState(''),[steps,setSteps]=useState<string[]>([]);
 const work=async(fn:()=>Promise<unknown>)=>{setBusy(true);setError('');try{await fn();onUpdated()}catch(e){setError(readableError(e))}finally{setBusy(false)}};
 if(!plan)return null;
 const unresolved=sreUnresolvedOperations(task),currentRun=task.runs?.at(-1),awaiting=task.attempts?.some(a=>a.planRunId===currentRun?.id&&agentRuns.some(r=>r.id===a.roleRunId&&r.sreTaskId===task.id&&(r.pending||r.status==='waiting_approval'))),hasRunning=task.attempts?.some(a=>a.operations?.some(o=>o.status==='dispatched')),planStatus=unresolved.length?'unknown':hasRunning?'running':awaiting?'waiting_approval':task.status;
 const control=(action:string)=>work(()=>api.sreOperation(task.sessionId,task.id,'control',{action,expectedRevision:task.revision,clientRequestId:crypto.randomUUID()}));
 const exportDraft=()=>work(async()=>{const value=await api.sreExport(task.sessionId,task.id);const blob=new Blob([value.content],{type:'application/json'});const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='lake-runbook-draft.json';a.click();URL.revokeObjectURL(url)});
 return <section className="sre-plan" aria-label="SRE 任务计划">
  <header><span><Glyph name="document" size={16}/><strong>Plan · {plan.goal}</strong><small>v{plan.version}</small></span><span className={`sre-state state-${planStatus}`}>{sreStatus[planStatus]??planStatus}</span></header>
  <p className="sre-plan-goal">目标：{plan.acceptance?.length?plan.acceptance.map(c=>c.description).join('；'):plan.goal}</p>
  <p className="sre-plan-scope">范围：{plan.scope.map(id=>resources.find(r=>r.id===id)?.name??'资源不可用').join('、')}</p>
  {!plan.collaborationVersion&&sreTaskActive(task)&&plan.steps.filter(s=>s.role==='investigator').length>1&&!plan.steps.some(s=>s.role==='verifier'||s.role==='executor')&&<p className="sre-plan-scheduling">当前为顺序分工：调查员先完成采集，协调者再汇总。</p>}
  <ol>{plan.steps.map(step=>{const attempt=sreStepAttempt(task,step),status=sreStepStatus(task,step,agentRuns);return <li key={step.id}><span className={`sre-step-mark status-${status}`}><Glyph name={status==='succeeded'?'check':status==='running'?'clock':status==='unknown'||status==='failed'?'alert':'clock'} size={13}/></span><span className="sre-step-description">{step.description}</span><small>{sreRoles[step.role].name}</small><span className={`sre-state state-${status}`} title={attempt?.reusedFromAttemptId?'沿用已有完成记录，未重新执行':undefined}>{attempt?.reusedFromAttemptId?'已沿用':sreStatus[status]??status}</span></li>})}</ol>
  {hasRunning&&<p className="sre-plan-scheduling" role="status">原操作仍在执行，等待原命令结果；不会重复派发。</p>}
  <SREBlockers task={task} resources={resources} onUpdated={onUpdated}/>
  {task.error&&!(unresolved.length&&(task.error.includes('结果不明')||task.error.includes('结果待核实')))&&<p className="sre-task-error" role="status">{displayAiError(task.error)}</p>}
  {(task.runs?.at(-1)?.planRevisionId===plan.id?task.verifications?.at(-1):undefined)?.checks?.filter(c=>c.reason.includes('人工')&&!c.attestedBy).map(c=><div className="sre-attestation" key={c.checkId}><span>{c.reason}</span><button type="button" disabled={busy} onClick={()=>void work(()=>api.sreOperation(task.sessionId,task.id,'attest',{checkId:c.checkId,passed:true}))}>记录人工通过</button><button type="button" disabled={busy} onClick={()=>void work(()=>api.sreOperation(task.sessionId,task.id,'attest',{checkId:c.checkId,passed:false}))}>未通过</button></div>)}
  <footer><details><DisclosureSummary>修订与详情</DisclosureSummary><div>{task.plans.map(p=><div className="sre-revision" key={p.id}><strong>v{p.version}</strong><time>{new Date(p.createdAt).toLocaleTimeString('zh-CN')}</time><p>{p.changeReason||'建立计划'}</p><ol>{p.steps.map(s=><li key={s.id}>{s.description}</li>)}</ol></div>)}<p>模型用量 {task.budgetSpent.toLocaleString()} / {task.tokenBudget.toLocaleString()} · {task.usage?.known?'已报告用量':'含预留或估算'}</p></div></details><div className="sre-plan-actions">
   {sreCanStart(task)&&<button type="button" className="button primary" disabled={busy||!enabled} title={enabled?undefined:'请先开启 SRE 协作'} onClick={()=>void work(()=>api.sreOperation(task.sessionId,task.id,'start',{planVersion:plan.version,clientRequestId:crypto.randomUUID()}))}>{task.runs?.length?(task.runs.at(-1)?.planRevisionId===plan.id?'继续任务':'开始新计划'):'开始执行'}</button>}
   {['active','waiting_approval'].includes(task.status)&&<button type="button" disabled={busy} onClick={()=>void control('pause')}>暂停</button>}
   {sreTaskActive(task)&&<button type="button" disabled={busy} onClick={()=>void control('cancel')}>结束任务</button>}
   {['draft','paused','waiting_input'].includes(task.status)&&<button type="button" disabled={busy} onClick={()=>{setGoal(plan.goal);setSteps(plan.steps.map(s=>s.description));setEditing(!editing)}}>修改计划</button>}
   {!sreTaskActive(task)&&<button type="button" disabled={busy} onClick={()=>void exportDraft()}>导出手册草稿</button>}
  </div></footer>
  {editing&&<form className="sre-plan-edit" onSubmit={e=>{e.preventDefault();void work(async()=>{await api.sreOperation(task.sessionId,task.id,'plans',{expectedVersion:plan.version,plan:{...plan,goal,steps:plan.steps.map((s,i)=>({...s,description:steps[i]})),changeReason:'用户修改计划'}});setEditing(false)})}}><label>任务目标<input value={goal} maxLength={1000} onChange={e=>setGoal(e.target.value)} required/></label>{plan.steps.map((s,i)=><label key={s.id}>{sreRoles[s.role].name}<input value={steps[i]??''} maxLength={1000} required onChange={e=>setSteps(old=>old.map((v,n)=>n===i?e.target.value:v))}/></label>)}<p>描述修改不改变已绑定的动作参数。调整操作请在对话中说明。</p><button type="submit" className="button primary" disabled={busy}>保存新版本</button><button type="button" onClick={()=>setEditing(false)}>取消</button></form>}
  {error&&<p role="alert" className="sre-task-error">{error}</p>}
 </section>
}
