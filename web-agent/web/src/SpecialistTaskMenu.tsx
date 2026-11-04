import {useEffect, useId, useLayoutEffect, useState, type KeyboardEvent} from 'react';
import {createPortal} from 'react-dom';
import type {SuperWorker} from '../../shared/contracts';
import {api, readableError} from './api';
import {DisclosureSummary} from './DisclosureSummary';
import {Glyph} from './Icons';
import {superTaskPresentation} from './superAgentPresentation';
import {useTerminalPopover} from './useTerminalPopover';

type Props = {
  sessionId: string;
  currentTaskId?: string;
  source?: string;
  onTask: (worker: SuperWorker) => void;
};

const dateFormat = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

function duplicateTaskLabels(workers: SuperWorker[]) {
  const byTitle = new Map<string, SuperWorker[]>();
  for (const worker of workers) {
    const group = byTitle.get(worker.task.title);
    if (group) group.push(worker);
    else byTitle.set(worker.task.title, [worker]);
  }
  const labels = new Map<string, string>();
  for (const group of byTitle.values()) {
    if (group.length < 2) continue;
    const occurrences = new Map<string, number>();
    for (const worker of group) {
      const date = Date.parse(worker.createdAt ?? '');
      const time = Number.isFinite(date) ? dateFormat.format(date) : '';
      const occurrence = (occurrences.get(time) ?? 0) + 1;
      occurrences.set(time, occurrence);
      const label = time || '同名任务';
      labels.set(worker.id, time && occurrence === 1 ? time : `${label} · ${occurrence}`);
    }
  }
  return labels;
}

function TaskRows({sessionId, currentTaskId, onTask}: Pick<Props, 'sessionId' | 'currentTaskId' | 'onTask'>) {
  const [workers, setWorkers] = useState<SuperWorker[] | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const request = new AbortController();
    setWorkers(null);
    setError('');
    api.specialistTasks(sessionId, request.signal).then(rows => {
      if (!request.signal.aborted) setWorkers(rows);
    }).catch(reason => {
      if (!request.signal.aborted) setError(readableError(reason));
    });
    return () => request.abort();
  }, [sessionId, attempt]);

  if (error) return <div className="specialist-task-notice">
    <span role="alert">无法加载任务清单。{error}</span>
    <button type="button" className="button" onClick={() => setAttempt(value => value + 1)}>重试</button>
  </div>;
  if (!workers) return <p className="specialist-task-notice" role="status">正在加载任务…</p>;
  if (!workers.length) return <p className="specialist-task-notice">暂无任务</p>;
  const labels = duplicateTaskLabels(workers);
  return <ul className="specialist-task-rows">{workers.map(worker => {
    const current = worker.task.taskId === currentTaskId;
    const state = superTaskPresentation(worker.task);
    const subtitle = labels.get(worker.id);
    return <li key={worker.task.taskId}><button type="button" className="specialist-task-row"
      aria-current={current || undefined} title={worker.task.title} onClick={() => onTask(worker)}>
      <span className="specialist-task-copy"><span className="specialist-task-title">{worker.task.title}</span>
        {subtitle && <small>{subtitle}</small>}
      </span>
      <small data-tone={state.tone}>{state.label}</small>
      <Glyph name={current ? 'check' : 'next'} size={13}/>
    </button></li>;
  })}</ul>;
}

function navigateRows(event: KeyboardEvent<HTMLDivElement>) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const rows = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('.specialist-task-row'));
  if (!rows.length) return;
  const index = rows.indexOf(document.activeElement as HTMLButtonElement);
  if (index === -1 && event.target !== event.currentTarget) return;
  event.preventDefault();
  let target = 0;
  if (event.key === 'End') target = rows.length - 1;
  if (event.key === 'ArrowUp') target = index <= 0 ? rows.length - 1 : index - 1;
  if (event.key === 'ArrowDown') target = (index + 1) % rows.length;
  rows[target]?.focus();
}

export function SpecialistTaskMenu({sessionId, currentTaskId, source, onTask}: Props) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const {trigger, menu} = useTerminalPopover(open, () => setOpen(false));

  useLayoutEffect(() => {
    const button = trigger.current, panel = menu.current;
    if (!open || !button || !panel) return;
    const header = button.closest('.workspace-header') ?? button;
    const place = () => {
      const rect = header.getBoundingClientRect();
      const top = rect.bottom + 6;
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - panel.offsetWidth - 8));
      Object.assign(panel.style, {left: left + 'px', top: top + 'px', maxHeight: Math.min(420, Math.max(0, window.innerHeight - top - 8)) + 'px'});
    };
    place();
    panel.focus({preventScroll: true});
    const observer = new ResizeObserver(place);
    observer.observe(header);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, trigger, menu]);

  return <>
    <button type="button" ref={trigger} className="specialist-task-trigger" title="任务清单" aria-label="专员任务清单"
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined}
      onClick={() => setOpen(value => !value)}><Glyph name="listTasks" size={16}/></button>
    {open && createPortal(<div ref={menu} id={panelId} className="specialist-task-menu"
      role="dialog" aria-label="任务清单" tabIndex={-1} onKeyDown={navigateRows}>
      <h2>任务清单</h2>
      {currentTaskId && source && <details className="specialist-task-source">
        <DisclosureSummary>当前任务来源</DisclosureSummary><p>{source}</p>
      </details>}
      <TaskRows key={sessionId} sessionId={sessionId} currentTaskId={currentTaskId} onTask={worker => {
        trigger.current?.focus({preventScroll: true});
        setOpen(false);
        onTask(worker);
      }}/>
    </div>, document.body)}
  </>;
}
