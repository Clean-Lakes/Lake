import type {ScheduledTask} from '../../shared/contracts';
import {Glyph} from './Icons';
import {scheduleStatus,scheduleTime} from './scheduledTaskPresentation';

export function ScheduleHistory({task,onOpenSession}:{task:ScheduledTask;onOpenSession:(id:string)=>void}){
 const history=[...(task.history??[])].reverse();
 return <section className="schedule-history" aria-label="执行记录"><h3>执行记录 <small>最近 100 次</small></h3>
 {!history.length&&<p className="schedule-empty">{task.last_at?'旧版仅保留最近状态，后续执行会开始留存记录。':'首次执行后，结果会保存在这里。'}</p>}
 {history.length>0&&<ol>{history.map(run=><li key={run.id}><div className="schedule-history-heading"><strong className={run.status==='failed'?'schedule-error':''}>{scheduleStatus(run.status)}</strong><time>{scheduleTime(run.started_at??run.scheduled_at)}</time></div><p>{run.started_at?'开始':'计划'} {scheduleTime(run.started_at??run.scheduled_at)}{run.finished_at&&` · 结束 ${scheduleTime(run.finished_at)}`}</p>{run.error&&<p className="schedule-error">{run.error}</p>}{run.session_id&&<button type="button" className="schedule-text-action" onClick={()=>onOpenSession(run.session_id!)}>查看会话与结果<Glyph name="next" size={13}/></button>}</li>)}</ol>}
 </section>;
}

