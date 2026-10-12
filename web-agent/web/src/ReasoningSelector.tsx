import { useEffect, useRef, useState } from "react";
import type { ReasoningSettings } from "../../shared/contracts";
import { api, readableError } from "./api";

const labels: Record<string, string> = { "": "默认", none: "关闭", minimal: "极低", low: "低", medium: "中", high: "高", xhigh: "极高", max: "最高" };

export function ReasoningSelector({ session, modelId, disabled, onSaving }: {
  session: string; modelId?: string | null; disabled: boolean; onSaving: (saving: boolean) => void;
}) {
  const [settings, setSettings] = useState<(ReasoningSettings & { session: string }) | null>(null);
  const [open, setOpen] = useState(false), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const current = useRef({ session, modelId }); current.current = { session, modelId };
  useEffect(() => {
    let cancelled = false; setSettings(null); setOpen(false); setError("");
    if (modelId) void api.reasoning(session).then(value => {
      if (!cancelled && value.modelId === modelId) setSettings({ ...value, session });
    }).catch(error => { if (!cancelled) setError(readableError(error)); });
    return () => { cancelled = true; };
  }, [session, modelId]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); root.current?.querySelector<HTMLButtonElement>("button")?.focus(); } };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);
  const valid = settings?.session === session && settings.modelId === modelId;
  if (!modelId || valid && !settings.levels.length || !valid && !error) return null;
  const select = async (effort: string) => {
    if (busy || disabled || !valid || !settings.modelId) return;
    const origin = { session, modelId }; setBusy(true); onSaving(true); setError(""); setOpen(false);
    try {
      const saved = await api.setReasoning(session, settings.modelId, effort);
      if (current.current.session === origin.session && current.current.modelId === origin.modelId) setSettings({ ...saved, session });
    } catch (error) {
      if (current.current.session === origin.session && current.current.modelId === origin.modelId) setError(readableError(error));
    } finally { setBusy(false); onSaving(false); }
  };
  const label = valid ? labels[settings.effort] ?? settings.effort : "级别不可用";
  return <div className="reasoning-switch-wrap" ref={root}>
    <button type="button" className="model-switch reasoning-switch" aria-label={`思考级别：${label}`} title="思考级别" aria-haspopup="menu" aria-expanded={open} disabled={disabled || busy || !valid} onClick={() => setOpen(value => !value)}>
      <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 5a3 3 0 0 0-5.8-1 4 4 0 0 0-3 6 4 4 0 0 0 0 6 4 4 0 0 0 4 5A3 3 0 0 0 12 19V5Zm0 0a3 3 0 0 1 5.8-1 4 4 0 0 1 3 6 4 4 0 0 1 0 6 4 4 0 0 1-4 5A3 3 0 0 1 12 19M7 7c0 2-1 3-3 3m13-3c0 2 1 3 3 3M7 15c2 0 3 1 3 3m7-3c-2 0-3 1-3 3"/></svg>
      <span>{busy ? "保存中…" : label}</span><svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>
    </button>
    {open && valid && <div className="model-menu reasoning-menu" role="menu" aria-label="思考级别"><span className="model-menu-head">思考级别</span>{["", ...settings.levels].map(effort => <button key={effort} type="button" role="menuitemradio" aria-checked={settings.effort === effort} className={`model-menu-item ${settings.effort === effort ? "selected" : ""}`} onClick={() => void select(effort)}><span>{labels[effort] ?? effort}{!effort && settings.default ? `（${labels[settings.default] ?? settings.default}）` : ""}</span>{settings.effort === effort && <span aria-hidden="true">✓</span>}</button>)}</div>}
    {error && <p className="reasoning-error" role="alert">{error}</p>}
  </div>;
}
