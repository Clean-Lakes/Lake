import { useEffect, useId, useRef, useState } from "react";
import { api } from "./api";
import type { AIView, WorkSession } from "../../shared/contracts";

const compact = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : n.toLocaleString();
const count = (n?: number | null) => n === undefined || n === null ? "--" : compact(n);

export function ContextUsage({view, model, status = "completed", compact = false}: {view: AIView; model?: {modelId?: string | null}; status?: WorkSession["status"]; compact?: boolean}) {
  const [capacity, setCapacity] = useState<{modelId?: string; limit: number; source?: string} | null>(null);
  const [open, setOpen] = useState(false); const [pinned, setPinned] = useState(false);
  const root = useRef<HTMLDivElement>(null); const panelId = useId();
  useEffect(() => {setOpen(false); setPinned(false);}, [view.session]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {if (!root.current?.contains(event.target as Node)) {setOpen(false); setPinned(false);}};
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  useEffect(() => {
    let cancelled = false; setCapacity(null);
    if (view.context?.modelId) void api.modelCapacity().then(value => {if (!cancelled) setCapacity(value);}).catch(() => {});
    return () => {cancelled = true;};
  }, [view.context?.modelId, model?.modelId]);
  const context = view.context;
  const sameModel = !model?.modelId || model.modelId === context?.modelId;
  const discovered = capacity?.modelId === (model?.modelId || context?.modelId) && capacity?.source === "provider" ? capacity.limit : undefined;
  const window = discovered && discovered > 0 ? discovered : sameModel && ["provider", "settings"].includes(context?.windowSource || "") && context!.window > 0 ? context!.window : undefined;
  const allocation = sameModel ? context?.budget && context.budget > 0 ? context.budget : window : undefined;
  const inputBudget = sameModel && context?.inputBudget && context.inputBudget > 0 ? context.inputBudget : allocation;
  const effectiveInputBudget = window && inputBudget ? Math.min(window,inputBudget) : inputBudget;
  const used = sameModel && context?.usedKnown ? context.used : undefined; const percent = used !== undefined && effectiveInputBudget ? used / effectiveInputBudget * 100 : undefined;
  const last = sameModel ? context?.lastRequest : undefined; const reported = !!last?.known || !!last && last.total > 0;
  const totalKnown = !!view.usage.known;
  const nearLimit = percent !== undefined && percent >= 85;
  const warningId = `${panelId}-warning`;
  return <div className="ai-context-usage" data-session-status={status} ref={root} onMouseEnter={() => setOpen(true)} onMouseLeave={() => {if (!pinned) setOpen(false);}} onFocus={() => setOpen(true)} onBlur={event => {if (!pinned && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);}} onKeyDown={event => {if (event.key === "Escape") {setOpen(false); setPinned(false);}}}>
    <button type="button" className="ai-context-trigger" aria-label="上下文用量" aria-expanded={open} aria-controls={panelId} aria-describedby={nearLimit ? warningId : undefined} onClick={() => {setPinned(!pinned); setOpen(!pinned);}}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle className="ai-context-track" cx="12" cy="12" r="9"/><circle className="ai-context-fill" cx="12" cy="12" r="9" pathLength="100" strokeDasharray={`${Math.min(100, Math.max(0, percent ?? 0))} 100`}/></svg>
      <span className={compact ? "visually-hidden" : undefined}>上下文 {percent === undefined ? "--" : `${percent.toFixed(percent < 1 ? 2 : 1)}%`}</span>
    </button>
    {nearLimit && <span id={warningId} className="visually-hidden">上下文输入预算接近或超过上限</span>}
    {open && <section className="ai-context-panel" id={panelId} role="region" aria-label="上下文用量详情">
      <strong>本会话上下文预算</strong><div className="ai-context-window">{count(allocation)} <small>tokens</small></div>
      <dl><div><dt>模型支持窗口</dt><dd>{count(window)} tokens</dd></div><div><dt>单次输出预留</dt><dd>{count(sameModel ? context?.maxOutput : undefined)} tokens</dd></div><div><dt>最近请求输入占用</dt><dd>{count(used)} / {count(effectiveInputBudget)}</dd></div>
        <div><dt>最近请求输入 / 输出</dt><dd>{reported ? `${count(last!.inputKnown === false ? undefined : last!.input)} / ${count(last!.outputKnown === false ? undefined : last!.output)}` : "-- / --"}</dd></div>
        <div><dt>其中缓存命中</dt><dd>{last?.cachedInput === undefined || last.cachedInput === null ? (last ? "服务商未返回" : "暂无数据") : `${count(last.cachedInput)} tokens`}</dd></div>
        <div className="ai-context-total"><dt>会话累计</dt><dd>{totalKnown ? `${count(view.usage.total)} tokens` : "--"}</dd></div>
      </dl>{nearLimit && <p className="ai-context-budget-warning">上下文输入预算已使用 {percent.toFixed(1)}%，接近或超过上限。</p>}<p>进度环按本会话输入预算计算（总预算扣除单次输出预留），模型支持窗口另列。占用取最近一次请求实测输入 token；无实测值时显示 --，新请求完成后更新。</p>
    </section>}
  </div>;
}
