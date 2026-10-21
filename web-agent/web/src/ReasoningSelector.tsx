import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { ReasoningSettings } from "../../shared/contracts";
import { api, readableError } from "./api";

const labels: Record<string, string> = { "": "默认", none: "关闭", minimal: "极低", low: "低", medium: "中", high: "高", xhigh: "极高", max: "最高", ultra: "极致" };

/** The session's supported levels, embedded in the shared model popover. */
export function ReasoningSelector({ session, modelId, disabled, disabledReason, onSaving }: {
  session: string; modelId?: string | null; disabled: boolean; disabledReason?: string; onSaving: (saving: boolean) => void;
}) {
  const [settings, setSettings] = useState<(ReasoningSettings & { session: string }) | null>(null);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [retry, setRetry] = useState(0);
  const [preview, setPreview] = useState<string | null>(null);
  const current = useRef({ session, modelId }); current.current = { session, modelId };
  const saving = useRef(false);
  useEffect(() => {
    let cancelled = false; setSettings(null); setError(""); setPreview(null);
    if (modelId) void api.reasoning(session).then(value => {
      if (!cancelled && value.modelId === modelId) setSettings({ ...value, session });
    }).catch(error => { if (!cancelled) setError(readableError(error)); });
    return () => { cancelled = true; };
  }, [session, modelId, retry]);
  const valid = settings?.session === session && settings.modelId === modelId;
  const levels = valid ? settings.levels.filter(effort => effort !== "") : [];
  if (!modelId || valid && !levels.length) return null;
  const select = async (effort: string) => {
    if (saving.current || disabled || !valid || !settings.modelId) { setPreview(null); return; }
    if (effort === settings.effort) { setPreview(null); return; }
    const origin = { session, modelId }; saving.current = true; setBusy(true); onSaving(true); setError("");
    try {
      const saved = await api.setReasoning(session, settings.modelId, effort);
      if (current.current.session === origin.session && current.current.modelId === origin.modelId) setSettings({ ...saved, session });
    } catch (error) {
      if (current.current.session === origin.session && current.current.modelId === origin.modelId) setError(readableError(error));
    } finally { saving.current = false; setBusy(false); setPreview(null); onSaving(false); }
  };
  const effort = preview ?? (valid ? settings.effort : "");
  const stops = ["", ...levels];
  const index = Math.max(0, stops.indexOf(effort));
  const label = valid ? effort ? labels[effort] ?? effort : `默认${settings.default ? ` · ${labels[settings.default] ?? settings.default}` : ""}` : error ? "读取失败" : "读取中…";
  const hint = busy ? "正在保存…" : disabled ? disabledReason || "当前暂不能调整思考强度。" : "";
  const unavailable = disabled || busy || !valid;
  return <section className="composer-reasoning-panel" aria-label="思考强度" aria-busy={busy}>
    <div className="composer-reasoning-heading"><span>思考强度</span><strong aria-live="polite">{label}</strong></div>
    {valid && <>
      <div className="composer-reasoning-track" style={{"--reasoning-progress":index / (stops.length - 1)} as CSSProperties}>
        <input type="range" min={0} max={stops.length - 1} step={1} value={index} aria-label="思考强度" aria-valuetext={effort ? labels[effort] ?? effort : label} disabled={unavailable}
          onChange={event => setPreview(stops[Number(event.target.value)] ?? null)}
          onPointerUp={event => void select(stops[Number(event.currentTarget.value)]!)}
          onPointerCancel={() => setPreview(null)}
          onKeyUp={event => { if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) void select(stops[Number(event.currentTarget.value)]!); }}
          onBlur={() => { if (preview !== null) void select(preview); }}/>
        <span className="composer-reasoning-sparkles" aria-hidden="true"/>
      </div>
      <div className="composer-reasoning-scale" aria-hidden="true"><span>默认</span><span>{labels[levels.at(-1)!] ?? levels.at(-1)}</span></div>
    </> }
    {hint && <p className="composer-reasoning-hint">{hint}</p>}
    {error && <p className="composer-reasoning-error" role="alert">{error}{!valid && <button type="button" onClick={() => setRetry(value => value + 1)}>重试</button>}</p>}
  </section>;
}
