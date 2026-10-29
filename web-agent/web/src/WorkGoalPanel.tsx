import {useState} from 'react';
import type {WorkGoal} from '../../shared/contracts';
import {api,readableError} from './api';
import {Glyph} from './Icons';
import {DisclosureSummary} from './DisclosureSummary';
import './workGoalPanel.css';

const labels:Record<string,string>={running:'处理中',pending:'待处理',waiting_external:'等待外部任务',waiting_user:'等待用户',blocked:'需关注',paused:'已暂停',completed:'已完成',failed:'未完成',cancelled:'已停止跟进'};
export function WorkGoalPanel({goals,sessionId,connected,onUpdated}:{goals:WorkGoal[];sessionId:string;connected:boolean;onUpdated:()=>void}){
 const [busy,setBusy]=useState(''),[error,setError]=useState('');
 async function control(goal:WorkGoal,command:string){setBusy(goal.id);setError('');try{await api.aiOperation(sessionId,'workControl',{goalId:goal.id,command,revision:goal.revision});onUpdated();}catch(e){setError(readableError(e));onUpdated();}finally{setBusy('');}}
 if(!goals.length)return null;
 return <section className="work-goal-panel" aria-label="持续跟进的工作目标">
  {goals.map(goal=>{const ended=['completed','failed','cancelled'].includes(goal.status);return <details key={goal.id} open={!ended} className="work-goal">
   <DisclosureSummary><Glyph name={goal.status==='completed'?'check':goal.status==='blocked'?'alert':'clock'} size={16}/><strong>{goal.title}</strong><span>{labels[goal.status]??goal.status}</span></DisclosureSummary>
   <ul>{goal.items.map(item=><li key={item.id}><Glyph name={item.status==='completed'?'check':item.status==='failed'||item.status==='blocked'?'alert':'clock'} size={14}/><div><span>{item.title}</span><small>{labels[item.status]??item.status}</small>{item.reason&&<p>{item.reason}</p>}{item.watch?.lastObservedAt&&<small>最近核对：{new Date(item.watch.lastObservedAt).toLocaleTimeString()}</small>}</div></li>)}</ul>
   {goal.summary&&<p className="work-goal-summary">{goal.summary}</p>}
   <footer><small>模型调用 {goal.modelRounds} / {goal.roundLimit}</small>{!ended&&<div>{goal.status==='waiting_user'?<small>请在会话中补充前置条件</small>:['paused','blocked'].includes(goal.status)?<button type="button" disabled={!connected||!!busy} onClick={()=>void control(goal,'resume')}>继续跟进</button>:<button type="button" disabled={!connected||!!busy} onClick={()=>void control(goal,'pause')}>暂停</button>}<button type="button" disabled={!connected||!!busy} title="停止后续跟进，不代表远端任务已停止" onClick={()=>void control(goal,'cancel')}>停止跟进</button></div>}</footer>
  </details>})}
  {error&&<p role="alert" className="work-goal-error">{error}</p>}
 </section>;
}
