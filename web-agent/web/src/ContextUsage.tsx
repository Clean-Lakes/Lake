import { useEffect, useId, useRef, useState } from "react";
import { api } from "./api";
import type { AIView } from "../../shared/contracts";

const compact = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : n.toLocaleString();
const count = (n?: number | null) => n === undefined || n === null ? "--" : compact(n);

export function ContextUsage({view, model}: {view: AIView; model?: {modelId?: string | null}}) {
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
  }, [view.context?.modelId, model]);
  const context = view.context;
  const sameModel = !model?.modelId || model.modelId === context?.modelId;
  const discovered = capacity?.modelId === (model?.modelId || context?.modelId) && capacity?.source === "provider" ? capacity.limit : undefined;
  const window = discovered && discovered > 0 ? discovered : sameModel && context?.windowSource === "provider" && context.window > 0 ? context.window : undefined;
  const used = sameModel && context?.usedKnown ? context.used : undefined; const percent = used !== undefined && window ? used / window * 100 : undefined;
  const last = sameModel ? context?.lastRequest : undefined; const reported = !!last?.known || !!last && last.total > 0;
  const totalKnown = !!view.usage.known;
  return <div className="ai-context-usage" ref={root} onMouseEnter={() => setOpen(true)} onMouseLeave={() => {if (!pinned) setOpen(false);}} onFocus={() => setOpen(true)} onBlur={event => {if (!pinned && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);}} onKeyDown={event => {if (event.key === "Escape") {setOpen(false); setPinned(false);}}}>
    <button type="button" className="ai-context-trigger" aria-label="上下文用量" aria-expanded={open} aria-controls={panelId} onClick={() => {setPinned(!pinned); setOpen(!pinned);}}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle className="ai-context-track" cx="12" cy="12" r="9"/><circle className={`ai-context-fill ${percent !== undefined && percent >= 85 ? "near-limit" : ""}`} cx="12" cy="12" r="9" pathLength="100" strokeDasharray={`${Math.min(100, Math.max(0, percent ?? 0))} 100`}/></svg>
      <span>上下文 {percent === undefined ? "--" : `${percent.toFixed(percent < 1 ? 2 : 1)}%`}</span>
    </button>
    {open && <section className="ai-context-panel" id={panelId} role="region" aria-label="上下文用量详情">
      <strong>模型上下文窗口</strong><div className="ai-context-window">{count(window)} <small>tokens</small></div>
      <dl><div><dt>最近请求占用</dt><dd>{count(used)} / {count(window)}</dd></div>
        <div><dt>最近请求输入 / 输出</dt><dd>{reported ? `${count(last!.inputKnown === false ? undefined : last!.input)} / ${count(last!.outputKnown === false ? undefined : last!.output)}` : "-- / --"}</dd></div>
        <div><dt>其中缓存命中</dt><dd>{last?.cachedInput === undefined || last.cachedInput === null ? (last ? "服务商未返回" : "暂无数据") : `${count(last.cachedInput)} tokens`}</dd></div>
        <div className="ai-context-total"><dt>会话累计</dt><dd>{totalKnown ? `${count(view.usage.total)} tokens` : "--"}</dd></div>
      </dl><p>{window ? "窗口上限由服务商返回。" : "服务商未返回窗口上限，暂不计算百分比。"}占用取最近一次请求报告的输入 token；新请求完成后更新。</p>
    </section>}
  </div>;
}
