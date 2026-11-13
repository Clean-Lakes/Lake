import type {SuperTask,SuperWorker,TaskCollaboration,WorkGoal} from '../../shared/contracts';
import {Glyph} from './Icons';
import {participantPresentation,superTaskPresentation} from './superAgentPresentation';
import {SuperRoleAvatar} from './SuperRoleAvatar';
import {useState} from 'react';
import {api,readableError} from './api';
import {DisclosureSummary} from './DisclosureSummary';

const stepLabels:Record<string,string>={pending:'待执行',running:'执行中',waiting_external:'等待外部结果',waiting_user:'等待你回答',blocked:'未完成',completed:'执行结束',failed:'执行失败',paused:'已暂停',cancelled:'已停止',ended:'执行结束',succeeded:'执行成功',queued:'排队中',unknown:'结果不确定'};

function JointTaskSummary({collaboration,sessionId,hideStatus=false}:{collaboration:TaskCollaboration;sessionId:string;hideStatus?:boolean}){
 const {participants}=collaboration;
 const submitted=participants.filter(member=>member.contributed).length;
 return <div className="joint-task-summary">
  {!hideStatus&&<p className="joint-task-verdict"><small>{submitted} / {participants.length} 位专员已提交报告</small></p>}
  <ul aria-label="协作专员">{participants.map(member=>{
   const current=member.sessionId===sessionId,status=participantPresentation(member);
   return <li key={member.workerId} aria-current={current||undefined}>
    <SuperRoleAvatar name={member.roleName} roleId={member.roleId} motion="still" size={16}/>
    <span className="joint-member-name" title={member.roleName}>{member.roleName}</span>{current&&<small>正在查看</small>}
    {!hideStatus&&<span className="joint-member-state" data-tone={status.tone}>{status.label}</span>}
   </li>;
  })}</ul>
 </div>;
}

export function SuperTaskInspector({task,goal,worker,plan=false,connected=false,onUpdated,summaryOnly=false,controlsOnly=false,hideHeading=false,hideStatus=false,foldSteps=false}:{task:SuperTask;goal:WorkGoal;worker?:SuperWorker;plan?:boolean;connected?:boolean;onUpdated?:()=>void;summaryOnly?:boolean;controlsOnly?:boolean;hideHeading?:boolean;hideStatus?:boolean;foldSteps?:boolean}){
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 const stop=async()=>{setBusy(true);setError('');try{await api.aiOperation(task.sessionId,'workControl',{goalId:task.executionGoalId??task.taskId,command:'cancel',revision:task.revision});onUpdated?.();}catch(reason){setError(readableError(reason));}finally{setBusy(false);}};
 const items=goal.items??[];
 const owner=worker?.sessionId===task.sessionId&&worker.task.taskId===task.taskId?worker:undefined,state=superTaskPresentation(task);
 const updated=task.updatedAt&&Number.isFinite(Date.parse(task.updatedAt))?task.updatedAt:undefined;
 const steps=items.length?<ol className="super-task-steps">{items.map((item,index)=><li key={item.id} data-state={item.status}>
  <span className="super-step-number">{item.status==='completed'?<Glyph name="check" size={12}/>:index+1}</span><div><strong>{item.title}</strong><small>{stepLabels[item.status]??'待核实'}</small>{item.reason&&<p>{item.reason}</p>}
   {item.attempts && item.attempts.length > 1 && <details className="super-step-attempts"><summary>{item.attempts.length} 次执行</summary>
     {item.attempts.map(attempt=><p key={attempt.id}><time dateTime={attempt.createdAt}>{new Date(attempt.createdAt).toLocaleString()}</time> · {stepLabels[attempt.status]??'待核实'}</p>)}</details>}</div>
 </li>)}</ol>:null;
 return <section className={`super-task-inspector${summaryOnly?' super-task-overview':''}`} aria-label={plan?'任务计划':'当前任务执行'}>
  {!controlsOnly&&!hideHeading&&<><div className="super-task-heading"><Glyph name="document" size={17}/><strong>{task.title}</strong></div>
  {!hideStatus&&!task.collaboration&&<div className="super-task-state"><span className="super-task-verdict" data-tone={state.tone}><Glyph name={state.tone==='danger'||state.tone==='attention'?'alert':state.tone==='active'?'loader':'clock'} size={13}/>{state.label}</span></div>}
  {task.collaboration?<JointTaskSummary collaboration={task.collaboration} sessionId={task.sessionId} hideStatus={hideStatus}/>:owner&&<p className="worker-task-origin"><SuperRoleAvatar name={owner.roleName} roleId={owner.roleId} pilot={owner.roleId==='pilot:'+task.projectId} size={16} motion="still"/>{owner.roleName}</p>}
  {updated&&<time className="super-task-updated" dateTime={updated}>更新于 {new Date(updated).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false})}</time>}
  {!summaryOnly&&task.summary&&['paused','blocked','failed'].includes(task.state)&&<p className="inspector-empty">{task.summary}</p>}</>}
  {!summaryOnly&&!controlsOnly&&(foldSteps?steps&&<details className="super-task-step-records"><DisclosureSummary><span>执行步骤</span><small>{items.length} 项</small></DisclosureSummary>{steps}</details>:steps??<p className="inspector-empty">计划生成后会显示在这里。</p>)}
  {!plan&&!summaryOnly&&!['completed','failed','cancelled'].includes(task.state)&&<button type="button" className="button secondary" disabled={!connected||busy} aria-busy={busy} onClick={()=>void stop()} aria-label={task.collaboration?`停止${owner?.roleName??"当前专员"}参与「${task.title}」的执行`:`停止任务：${task.title}`} title={task.collaboration?"其他专员会继续执行":`仅停止「${task.title}」，不影响该专员的其他任务`}><Glyph name={busy?'loader':'stop'} size={13}/>{busy?'正在停止…':task.collaboration?'停止本专员的执行':'仅停止此任务'}</button>}
  {error&&<p role="alert" className="super-task-control-error">{error}</p>}
 </section>;
}
