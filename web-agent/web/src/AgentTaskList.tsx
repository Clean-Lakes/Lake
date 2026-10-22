import {DisclosureSummary} from './DisclosureSummary';
import { StatusText } from "./StatusText";
import { useEffect, useId, useState, type ReactNode } from "react";
import type { AgentRun, AgentRunStatus, Evidence, Resource } from "../../shared/contracts";
import { AgentIcon } from "./AgentIcon";
import { activeAgentStatus, agentDuration, agentGroupLabel, agentIdentity, agentStatusLabels, agentSummary } from "./agentTasks";
import { readableError } from "./api";
import {AssistantMarkdown} from './AssistantMarkdown';

function StatusIcon({ status }: { status: AgentRunStatus }) {
  if (status === "running") return null;
  return <svg className="agent-status-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {<><circle cx="8" cy="8" r="6"/>{status === "completed" ? <path d="m5 8 2 2 4-4"/> : status === "queued" ? <path d="M8 4v4l2 1"/> : status === "cancelled" ? <rect x="6" y="6" width="4" height="4" rx=".5"/> : status === "waiting_approval" ? <path d="M6 5v6M10 5v6"/> : <path d="M8 4.5v4M8 11h.01"/>}</>}
  </svg>;
}

export function AgentTaskList({ runs, resources, evidence = [], live = false, onInspect, onStopTurn, onCancelRun, renderApproval, disabled = false, stopping = false, children, compact = false }: {
  runs: AgentRun[]; resources: Resource[]; evidence?: Evidence[]; live?: boolean; onInspect?: () => void;
  onStopTurn?: () => void; onCancelRun?: (run: AgentRun) => Promise<unknown>; disabled?: boolean; stopping?: boolean;
  renderApproval?: (run: AgentRun) => ReactNode;
  children?: ReactNode; compact?: boolean;
}) {
  const id = useId();
  const [now, setNow] = useState(Date.now);
  const [cancelling, setCancelling] = useState<string[]>([]);
  const [error, setError] = useState("");
  const timed = runs.some(run => activeAgentStatus(run.status) && run.startedAt);
  useEffect(() => {
    if (!timed) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [timed]);
  if (!runs.length) return null;
  const completed = runs.filter(run => run.status === "completed").length;
  const processing = live && (runs.some(run => run.status === "running") || !runs.some(run => run.status === "waiting_approval"));
  const resourceMap = new Map(resources.map(resource => [resource.id, resource]));
  const allEvidence = [...new Map([...evidence, ...runs.flatMap(run => (run.evidence || []).map(item => ({...item, specialistId: null, command: null})))].map(item => [item.id, item])).values()];
  const cancel = async (run: AgentRun) => {
    if (!onCancelRun || !run.canCancel || !activeAgentStatus(run.status) || cancelling.includes(run.id) || disabled) return;
    setError(""); setCancelling(current => [...current, run.id]);
    try { await onCancelRun(run); } catch (cause) { setError(readableError(cause)); }
    finally { setCancelling(current => current.filter(item => item !== run.id)); }
  };
  const body = <div className="agent-task-body"><div className="agent-task-heading"><span>本轮子任务</span><span>{completed} / {runs.length} 已完成</span></div>
      <ol className="agent-task-rows">{runs.map(run => {
        const identity = agentIdentity(run);
        const summary = agentSummary(run);
        const target = run.resourceIds.map(resourceId => resourceMap.get(resourceId)?.name || "资源不可用").join("、") || "本轮调查";
        const collected = allEvidence.filter(item => (run.evidenceIds || []).includes(item.id) && item.sessionId === run.sessionId);
        const canCancel = !!onCancelRun && run.canCancel && activeAgentStatus(run.status);
        return <li key={run.id} className="agent-task-row" data-agent-id={run.id} data-agent-status={run.status}>
          <details onToggle={event => { if (event.currentTarget.open) onInspect?.(); }}>
            <summary><span className="agent-task-role"><AgentIcon role={identity.icon}/></span><span className="agent-task-copy"><span className="agent-task-title"><strong>{identity.name}</strong><span>{identity.label} · {target}</span></span><span className="agent-task-description">{summary || run.task}</span></span><span key={run.status} className={`agent-task-status status-${run.status}`}><StatusIcon status={run.status}/><StatusText text={agentStatusLabels[run.status] || "状态待核查"} active={live && run.status === "running"}/></span><svg className="agent-task-chevron" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></summary>
            <div className="agent-task-detail" id={`${id}-${run.id}`}><dl><dt>职责</dt><dd>{identity.label}</dd><dt>目标</dt><dd>{target}</dd><dt>任务</dt><dd>{run.task}</dd><dt>耗时</dt><dd className="agent-duration">{agentDuration(run, now)}</dd><dt>证据</dt><dd>{collected.length ? `${collected.length} 项` : run.status === "queued" ? "等待采集" : run.status === "running" ? "尚未收集" : "暂无已记录证据"}</dd>{typeof run.toolCount === "number" && <><dt>工具调用</dt><dd>{run.toolCount} 次</dd></>}</dl>
              {run.usage && <div className="agent-task-usage">模型用量：{!run.usage.total && !run.usage.known && !run.usage.inputKnown && !run.usage.outputKnown ? "服务商尚未返回" : <>{run.usage.total.toLocaleString()} tokens{!run.usage.known && !(run.usage.inputKnown && run.usage.outputKnown) ? "（已知部分）" : ""}</>} · 上下文独立</div>}
              {summary && <div className="agent-task-result"><span>任务结果</span><AssistantMarkdown>{summary}</AssistantMarkdown></div>}
              {collected.map(item => <details className="agent-task-evidence" key={item.id}><DisclosureSummary>{item.title}</DisclosureSummary>{item.command && <pre>{item.command}</pre>}<pre>{item.excerpt}</pre>{item.exitCode !== null && <small>退出码：{item.exitCode}</small>}</details>)}
              {canCancel && <button type="button" className="agent-cancel-button" disabled={disabled || cancelling.includes(run.id)} onClick={() => void cancel(run)}>{cancelling.includes(run.id) ? "正在停止…" : `停止 ${identity.name}`}</button>}
            </div>
          </details>
          {!compact && (run.pending||run.question) && renderApproval && <div className="agent-run-approval">{renderApproval(run)}</div>}
        </li>;
      })}</ol>
      {children && <details className="agent-coordinator-detail" onToggle={event => { if (event.currentTarget.open) onInspect?.(); }}><DisclosureSummary>Lake 的操作记录</DisclosureSummary>{children}</details>}
      {error && <p className="agent-task-error" role="alert">{error}</p>}
      {live && onStopTurn && <div className="agent-task-footer"><span>结果汇总到当前会话</span><button type="button" className="agent-stop-turn" disabled={disabled || stopping} aria-busy={stopping} onClick={onStopTurn}><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><rect x="3" y="3" width="10" height="10" rx="1.5"/></svg>{stopping ? "正在停止…" : "停止本轮"}</button></div>}
    </div>;
  return <section className={`agent-task-list ${compact ? "agent-task-list-compact" : ""}`} aria-label="Lake 子 Agent 任务">{compact ? <details className="agent-process-details" onToggle={event=>{if(event.currentTarget.open)onInspect?.();}}><summary className="thinking-toggle"><span>委派 {runs.length} 个调查任务</span><svg className="thinking-chevron" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m6 4 4 4-4 4"/></svg></summary>{body}</details> : <>    <div className="agent-lead"><span className="agent-emblem"><AgentIcon role="lake" size={20}/></span><div className="agent-lead-copy"><div><strong>Lake</strong><span className="agent-group-state" role="status" aria-live="polite" aria-atomic="true"><StatusText text={agentGroupLabel(runs, live)} active={processing}/></span></div><p>{live ? "正在按任务汇总调查结果与证据。" : "已保留各任务的结果与证据。"}</p></div></div>
{body}</>}{compact&&runs.filter(run=>run.pending||run.question).map(run=>renderApproval&&<div className="agent-run-approval" key={run.id}>{renderApproval(run)}</div>)}</section>;
}
