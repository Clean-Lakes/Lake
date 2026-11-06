import type {SuperTask,SuperWorker,WorkGoal} from '../../shared/contracts';
import {Glyph} from './Icons';
import {superTaskPresentation} from './superAgentPresentation';
import {SuperRoleAvatar} from './SuperRoleAvatar';
import {useState} from 'react';
import {api,readableError} from './api';

const stepLabels:Record<string,string>={pending:'待执行',running:'执行中',waiting_external:'等待外部结果',waiting_user:'等待你回答',blocked:'待核实',completed:'执行结束',failed:'执行失败'};

export function SuperTaskInspector({task,goal,worker,plan=false,connected=false,onUpdated,summaryOnly=false,controlsOnly=false,hideHeading=false}:{task:SuperTask;goal:WorkGoal;worker?:SuperWorker;plan?:boolean;connected?:boolean;onUpdated?:()=>void;summaryOnly?:boolean;controlsOnly?:boolean;hideHeading?:boolean}){
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 const stop=async()=>{setBusy(true);setError('');try{await api.aiOperation(task.sessionId,'workControl',{goalId:task.taskId,command:'cancel',revision:task.revision});onUpdated?.();}catch(reason){setError(readableError(reason));}finally{setBusy(false);}};
 const items=goal.items??[];
 const accepted=task.state==='completed'&&task.acceptanceState==='pass';
 const owner=worker?.sessionId===task.sessionId&&worker.task.taskId===task.taskId?worker:undefined,state=superTaskPresentation(task);
 return <section className="super-task-inspector" aria-label={plan?'任务计划':'当前任务执行'}>
  {!controlsOnly&&!hideHeading&&<><div className="super-task-heading"><Glyph name="document" size={17}/><strong>{task.title}</strong></div>
  <div className="super-task-state"><span data-tone={state.tone}>{state.label}</span><small>{accepted?'验收通过':task.acceptanceState==='fail'?'验收未通过':'尚未通过目标验收'}</small></div>
  {owner&&<p className="worker-task-origin"><SuperRoleAvatar name={owner.roleName} roleId={owner.roleId} pilot={owner.roleId==='pilot:'+task.projectId} size={16} motion="still"/>任务来源 · {owner.roleName}</p>}
  {task.summary&&['paused','blocked','failed'].includes(task.state)&&<p className="inspector-empty">{task.summary}</p>}</>}
  {!summaryOnly&&!controlsOnly&&(!items.length?<p className="inspector-empty">计划生成后会显示在这里。</p>:<ol className="super-task-steps">{items.map((item,index)=><li key={item.id} data-state={item.status}>
   <span className="super-step-number">{item.status==='completed'?<Glyph name="check" size={12}/>:index+1}</span><div><strong>{item.title}</strong><small>{plan?'':stepLabels[item.status]??'待核实'}</small>{item.reason&&<p>{item.reason}</p>}</div>
  </li>)}</ol>)}
  {!plan&&!summaryOnly&&<p className="super-task-budget">{task.reason==='model_round_limit'?'模型调用轮数已达上限':<>已用 {goal.modelRounds} / {goal.roundLimit} 轮</>}</p>}
  {!plan&&!summaryOnly&&!['completed','failed','cancelled'].includes(task.state)&&<button type="button" className="button secondary" disabled={!connected||busy} onClick={()=>void stop()} title="停止后续跟进，保留原操作记录"><Glyph name="stop" size={13}/>停止任务</button>}
  {error&&<p role="alert" className="super-task-control-error">{error}</p>}
 </section>;
}
