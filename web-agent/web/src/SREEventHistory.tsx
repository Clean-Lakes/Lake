import {DisclosureSummary} from './DisclosureSummary';
import {useState} from 'react';
import type {SRETask} from '../../shared/contracts';
import {api,readableError} from './api';
const labels:Record<string,string>={task_created:'建立任务',plan_created:'建立计划',plan_revised:'修订计划',coordinator_replan:'协调者调整计划',run_started:'开始执行计划',step_started:'开始步骤',role_started:'专员接手任务',approval_requested:'等待操作确认',operation_prepared:'核对操作',operation_dispatched:'派发操作',operation_result:'记录操作结果',step_finished:'专员交付结果',verification_recorded:'记录独立验证',manual_verification:'记录人工确认',task_finished:'任务结束',task_paused:'任务暂停',recovered:'重启后恢复记录',role_answer:'专员回答',control_pause:'请求暂停',control_cancel:'结束任务'};
export function SREEventHistory({task}:{task:SRETask}){
 const [items,setItems]=useState<Array<{id:number;type:string;createdAt:string;payload:Record<string,unknown>}>>([]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[cursor,setCursor]=useState(0),[more,setMore]=useState(true);
 const load=async()=>{setBusy(true);setError('');try{const result=await api.sreEvents(task.sessionId,task.id,cursor);setItems(old=>[...new Map([...old,...result.items].map(i=>[i.id,i])).values()]);setCursor(result.items.at(-1)?.id??cursor);setMore(result.items.length===100)}catch(e){setError(readableError(e))}finally{setBusy(false)}};
 return <details className="sre-event-history" onToggle={e=>{if(e.currentTarget.open&&!items.length&&!busy)void load()}}><DisclosureSummary>执行流程 · {task.goal}</DisclosureSummary><ol>{items.filter(i=>!i.type.startsWith('budget_')).map(i=><li key={i.id}><time>{new Date(i.createdAt).toLocaleTimeString('zh-CN')}</time><details><DisclosureSummary>{labels[i.type]??'任务状态更新'}</DisclosureSummary><pre>{JSON.stringify(i.payload,null,2)}</pre></details></li>)}</ol>{more&&<button type="button" disabled={busy} onClick={()=>void load()}>{busy?'加载中…':'加载更多事件'}</button>}{error&&<p role="alert">{error}</p>}</details>
}
