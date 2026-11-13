import type {WatchdogFinding,WatchdogView} from '../../shared/contracts';
import {DisclosureSummary} from './DisclosureSummary';

const categories: Record<WatchdogFinding['kind'], string> = {
  stalled: '进展停滞', drift: '偏离分工', infrastructure: '运行异常', uncertain: '结果不确定',
};
const actions: Record<WatchdogFinding['action'], string> = {
  observed: '已记录', guided: '已排队纠偏', recovered: '已观察到新进展', skipped: '已跳过', retry_queued: '已排队重试',
};

function WatchdogRecord({finding}: {finding: WatchdogFinding}) {
  const date = new Date(finding.at);
  const timestamp = Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }) : '';
  return <li className="watchdog-record">
    <div className="watchdog-record-heading">
      <strong>{finding.verdict === 'progress' ? '正在推进' : categories[finding.kind]}</strong>
      <span>{actions[finding.action]}</span>
      {timestamp && <time dateTime={finding.at} title={date.toLocaleString('zh-CN')}>{timestamp}</time>}
    </div>
    <p>{finding.reason}</p>
    {finding.evidence.length > 0 && <details>
      <DisclosureSummary>巡检依据</DisclosureSummary>
      <ul>{finding.evidence.map((line, i) => <li key={i}>{line}</li>)}</ul>
    </details>}
  </li>;
}

export function TaskWatchdog({view}:{view:WatchdogView}) {
  const [latest, ...earlier] = [...view.findings].sort((a, b) => b.at.localeCompare(a.at));
  if(!latest)return null;
  return <section className="task-watchdog" aria-label="任务巡检">
    <h3 className="inspector-execution-title">任务巡检记录</h3>
    {latest && <ol aria-label="本次执行的巡检记录"><WatchdogRecord finding={latest}/></ol>}
    {earlier.length > 0 && <details className="watchdog-history">
      <DisclosureSummary>更早的 {earlier.length} 条记录</DisclosureSummary>
      <ol>{earlier.map(finding => <WatchdogRecord key={finding.id} finding={finding}/>)}</ol>
    </details>}
  </section>;
}
