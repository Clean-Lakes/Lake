import {useEffect, useRef, useState} from 'react';
import type {WatchdogFinding, WatchdogMode, WatchdogView} from '../../shared/contracts';
import {api, readableError} from './api';
import {AppSelect} from './AppSelect';
import {DisclosureSummary} from './DisclosureSummary';

const categories: Record<WatchdogFinding['kind'], string> = {
  stalled: '进展停滞', drift: '偏离分工', infrastructure: '运行异常', uncertain: '待核实',
};
const actions: Record<WatchdogFinding['action'], string> = {
  observed: '已记录', guided: '已排队纠偏', recovered: '已观察到新进展', skipped: '已跳过', retry_queued: '已排队重试',
};
const modes: Record<WatchdogMode, string> = {off: '关闭', observe: '仅观察', guide: '允许纠偏'};

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

export function TaskWatchdog({projectId, view, connected, onUpdated}: {
  projectId: string; view: WatchdogView; connected: boolean; onUpdated: () => void;
}) {
  const [saving, setSaving] = useState<WatchdogMode>();
  const [error, setError] = useState('');
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const changeMode = async (next: WatchdogMode) => {
    if (!connected || saving || next === view.mode) return;
    setSaving(next);
    setError('');
    try {
      await api.setWatchdogMode(projectId, next);
      if (mounted.current) onUpdated();
    } catch (cause) {
      if (mounted.current) setError(readableError(cause));
    } finally {
      if (mounted.current) setSaving(undefined);
    }
  };
  const [latest, ...earlier] = [...view.findings].sort((a, b) => b.at.localeCompare(a.at));
  return <section className="task-watchdog" aria-label="任务巡检">
    <label className="watchdog-setting">
      <span>项目巡检</span>
      <AppSelect aria-label="项目巡检模式" value={saving ?? view.mode} disabled={!connected || !!saving}
        aria-busy={!!saving} onChange={event => void changeMode(event.target.value as WatchdogMode)}>
        {(Object.keys(modes) as WatchdogMode[]).map(mode => <option key={mode} value={mode}>{modes[mode]}</option>)}
      </AppSelect>
    </label>
    {error && <p className="super-task-control-error" role="alert">{error}</p>}
    {latest && <ol aria-label="本次执行的巡检记录"><WatchdogRecord finding={latest}/></ol>}
    {earlier.length > 0 && <details className="watchdog-history">
      <DisclosureSummary>更早的 {earlier.length} 条记录</DisclosureSummary>
      <ol>{earlier.map(finding => <WatchdogRecord key={finding.id} finding={finding}/>)}</ol>
    </details>}
  </section>;
}
