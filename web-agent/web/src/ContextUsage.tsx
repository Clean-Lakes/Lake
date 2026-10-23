import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { api } from "./api";
import { Glyph } from "./Icons";
import type { AIView, WorkSession } from "../../shared/contracts";

const tokenCount = new Intl.NumberFormat("zh-CN", {notation: "compact", maximumFractionDigits: 1});
const count = (n?: number | null) => n === undefined || n === null ? "--" : tokenCount.format(n);

export function ContextUsage({view, model, status = "completed", compact = false}: {view: AIView; model?: {modelId?: string | null}; status?: WorkSession["status"]; compact?: boolean}) {
  const [capacity, setCapacity] = useState<{modelId?: string; limit: number; source?: string} | null>(null);
  const [open, setOpen] = useState(false); const [pinned, setPinned] = useState(false);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null); const panelId = useId();
  const [position, setPosition] = useState<{left: number; top: number} | null>(null);
  useEffect(() => {setOpen(false); setPinned(false);}, [view.session]);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      if (!trigger.current || !panel.current) return;
      const anchor = trigger.current.getBoundingClientRect(), box = panel.current.getBoundingClientRect();
      const left = Math.max(12, Math.min(anchor.right - box.width, window.innerWidth - box.width - 12));
      const top = Math.max(12, Math.min(anchor.top - box.height, window.innerHeight - box.height - 12));
      setPosition(previous => previous?.left === left && previous?.top === top ? previous : {left, top});
    };
    place();
    const observer = new ResizeObserver(place); if (panel.current) observer.observe(panel.current);
    window.addEventListener("resize", place); window.addEventListener("scroll", place, true);
    return () => {observer.disconnect(); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true);};
  }, [open]);
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
  const modelWindow = discovered && discovered > 0 ? discovered : sameModel && ["provider", "settings"].includes(context?.windowSource || "") && context!.window > 0 ? context!.window : undefined;
  const allocation = sameModel ? context?.budget && context.budget > 0 ? context.budget : modelWindow : undefined;
  const inputBudget = sameModel && context?.inputBudget && context.inputBudget > 0 ? context.inputBudget : allocation;
  const effectiveInputBudget = modelWindow && inputBudget ? Math.min(modelWindow,inputBudget) : inputBudget;
  const used = sameModel && context?.usedKnown ? context.used : undefined; const percent = used !== undefined && effectiveInputBudget ? used / effectiveInputBudget * 100 : undefined;
  const last = sameModel ? context?.lastRequest : undefined; const reported = !!last?.known || !!last && last.total > 0;
  const totalKnown = !!view.usage.known;
  const remaining = used !== undefined && effectiveInputBudget ? Math.max(0, effectiveInputBudget - used) : undefined;
  const cached = last?.cachedInput;
  const cachePercent = cached !== undefined && cached !== null && cached >= 0 && last && last.inputKnown !== false && last.input > 0 && cached <= last.input ? cached / last.input * 100 : undefined;
  const nearLimit = percent !== undefined && percent >= 85;
  const warningId = `${panelId}-warning`;
  return <div className="ai-context-usage" data-session-status={status} ref={root} onMouseEnter={() => setOpen(true)} onMouseLeave={() => {if (!pinned) setOpen(false);}} onFocus={() => setOpen(true)} onBlur={event => {if (!pinned && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);}} onKeyDown={event => {if (event.key === "Escape") {event.preventDefault(); event.stopPropagation(); trigger.current?.focus({preventScroll:true}); setOpen(false); setPinned(false);}}}>
    <button ref={trigger} type="button" className="ai-context-trigger" aria-label="上下文用量" aria-expanded={open} aria-controls={panelId} aria-describedby={nearLimit ? warningId : undefined} onClick={() => {setPinned(!pinned); setOpen(!pinned);}}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle className="ai-context-track" cx="12" cy="12" r="9"/><circle className="ai-context-fill" cx="12" cy="12" r="9" pathLength="100" strokeDasharray={`${Math.min(100, Math.max(0, percent ?? 0))} 100`}/></svg>
      <span className={compact ? "visually-hidden" : undefined}>上下文 {percent === undefined ? "--" : `${percent.toFixed(percent < 1 ? 2 : 1)}%`}</span>
    </button>
    {nearLimit && <span id={warningId} className="visually-hidden">上下文输入预算接近或超过上限</span>}
    {open && <div ref={panel} className="ai-context-popover" style={{left:position?.left, top:position?.top, visibility:position ? undefined : "hidden"}}><section className="ai-context-panel" id={panelId} role="region" aria-label="上下文用量详情">
      <header className="ai-context-heading"><strong>上下文用量</strong><span>{percent === undefined ? "--" : `${percent.toFixed(1)}%`}</span></header>
      <div className="ai-context-budget"><span>输入预算</span><span>{count(used)} / {count(effectiveInputBudget)} <small>tokens</small></span></div>
      <div className="ai-context-meter" role="progressbar" aria-label="上下文输入预算使用率" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent === undefined ? undefined : Math.min(100, Math.max(0, percent))} aria-valuetext={percent === undefined ? "暂无实测用量" : `已用 ${percent.toFixed(1)}%`}><span style={{width:`${Math.min(100, Math.max(0, percent ?? 0))}%`}}/></div>
      <dl className="ai-context-overview"><div><dt>剩余输入预算</dt><dd>{count(remaining)} <small>tokens</small></dd></div><div><dt>最近请求缓存命中</dt><dd>{cachePercent !== undefined ? `${cachePercent.toFixed(1)}%` : cached !== undefined && cached !== null ? `${count(cached)} tokens` : last ? "未返回" : "暂无请求"}</dd></div></dl>
      {nearLimit && <p className="ai-context-budget-warning">{percent >= 100 ? "已达到输入预算，继续对话时需整理上下文。" : "已接近输入预算，后续对话可能触发上下文整理。"}</p>}
      <details className="ai-context-details"><summary>用量明细<Glyph name="chevron" size={12}/></summary><dl><div><dt>会话总预算</dt><dd>{count(allocation)} tokens</dd></div><div><dt>模型支持窗口</dt><dd>{count(modelWindow)} tokens</dd></div><div><dt>单次输出预留</dt><dd>{count(sameModel ? context?.maxOutput : undefined)} tokens</dd></div>
        <div><dt>最近请求输入 / 输出</dt><dd>{reported ? `${count(last!.inputKnown === false ? undefined : last!.input)} / ${count(last!.outputKnown === false ? undefined : last!.output)}` : "-- / --"}</dd></div>
        <div><dt>其中缓存命中</dt><dd>{last?.cachedInput === undefined || last.cachedInput === null ? (last ? "服务商未返回" : "暂无数据") : `${count(last.cachedInput)} tokens`}</dd></div>
        <div className="ai-context-total"><dt>会话累计</dt><dd>{totalKnown ? `${count(view.usage.total)} tokens` : "--"}</dd></div>
      </dl><p>占用按最近请求的实测输入更新，比例以扣除输出预留后的输入预算为准。缓存命中率按该次请求的输入计算，缓存仍占上下文。</p></details>
    </section></div>}
  </div>;
}
