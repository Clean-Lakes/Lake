import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { ReasoningSettings } from "../../shared/contracts";
import { api, readableError } from "./api";

const glints=[{x:7,y:43,size:2,phase:-1,seconds:5.8},{x:16,y:62,size:2.5,phase:-4.3,seconds:7.2},{x:27,y:31,size:1.5,phase:-2,seconds:6.4},{x:39,y:60,size:2,phase:-5.1,seconds:8.2},{x:50,y:42,size:1.8,phase:-3,seconds:5.6},{x:63,y:29,size:2,phase:-6.2,seconds:7.8},{x:75,y:50,size:2.7,phase:-2.8,seconds:6.8},{x:88,y:61,size:2,phase:-4.7,seconds:8.6}];
const labels: Record<string, string> = { "": "默认", none: "关闭", minimal: "极低", low: "低", medium: "中", high: "高", xhigh: "极高", max: "最高", ultra: "极致" };

/** The session's supported levels, embedded in the shared model popover. */
export function ReasoningSelector({ session, modelId, disabled, disabledReason, onSaving }: {
  session: string; modelId?: string | null; disabled: boolean; disabledReason?: string; onSaving: (saving: boolean) => void;
}) {
  const [settings, setSettings] = useState<(ReasoningSettings & { session: string }) | null>(null);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [retry, setRetry] = useState(0);
  const [preview, setPreview] = useState<string | null>(null);
  const [dragProgress,setDragProgress]=useState<number|null>(null);
  const dragging=useRef(false);
  const current = useRef({ session, modelId }); current.current = { session, modelId };
  const saving = useRef(false);
  useEffect(() => {
    let cancelled = false; setSettings(null); setError(""); setPreview(null); setDragProgress(null);dragging.current=false;
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
      <div className="composer-reasoning-track" data-dragging={dragProgress!==null||undefined} data-disabled={unavailable||undefined} style={{"--reasoning-progress":dragProgress??index / (stops.length - 1)} as CSSProperties}>
        <input type="range" min={0} max={stops.length - 1} step={1} value={index} aria-label="思考强度" aria-valuetext={effort ? labels[effort] ?? effort : label} disabled={unavailable}
          onPointerDown={event=>{dragging.current=true;const rect=event.currentTarget.getBoundingClientRect();setDragProgress(Math.max(0,Math.min(1,(event.clientX-rect.left-14)/Math.max(1,rect.width-28))));}}
          onPointerMove={event=>{if(dragging.current){const rect=event.currentTarget.getBoundingClientRect();setDragProgress(Math.max(0,Math.min(1,(event.clientX-rect.left-14)/Math.max(1,rect.width-28))));}}}
          onChange={event => setPreview(stops[Number(event.target.value)] ?? null)}
          onPointerUp={event => {dragging.current=false;setDragProgress(null);void select(stops[Number(event.currentTarget.value)]!);}}
          onPointerCancel={() => {dragging.current=false;setDragProgress(null);setPreview(null);}}
          onKeyUp={event => { if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) void select(stops[Number(event.currentTarget.value)]!); }}
          onBlur={() => {dragging.current=false;setDragProgress(null);if (preview !== null) void select(preview); }}/>
        <span className="composer-reasoning-sparkles" aria-hidden="true">{glints.map((glint,i)=><i key={i} style={{left:`${glint.x}%`,top:`${glint.y}%`,width:glint.size,height:glint.size,animationDelay:`${glint.phase}s`,animationDuration:`${glint.seconds}s`}}/>)}</span>
        <span className="composer-reasoning-thumb" aria-hidden="true"/>
      </div>
      <div className="composer-reasoning-scale" aria-hidden="true"><span>默认</span><span>{labels[levels.at(-1)!] ?? levels.at(-1)}</span></div>
    </> }
    {hint && <p className="composer-reasoning-hint">{hint}</p>}
    {error && <p className="composer-reasoning-error" role="alert">{error}{!valid && <button type="button" onClick={() => setRetry(value => value + 1)}>重试</button>}</p>}
  </section>;
}
