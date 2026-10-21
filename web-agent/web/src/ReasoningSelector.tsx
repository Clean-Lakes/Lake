import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { ReasoningSettings } from "../../shared/contracts";
import { api, readableError } from "./api";
import { reasoningSaveQueue } from "./reasoningSaveQueue";

import {reasoningLabels as labels} from "./reasoningLabels";

export type ReasoningSelectorProps = {
  session: string; modelId?: string | null; disabled: boolean; disabledReason?: string; onSaving: (saving: boolean, session?:string) => void;
};

/** The session's supported levels, embedded in the shared model popover. */
export function ReasoningSelector({ session, modelId, disabled, disabledReason, onSaving }: ReasoningSelectorProps) {
  const [settings, setSettings] = useState<(ReasoningSettings & { session: string }) | null>(null);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [retry, setRetry] = useState(0);
  const [preview, setPreview] = useState<string | null>(null);
  const [dragProgress,setDragProgress]=useState<number|null>(null);
  const dragging=useRef(false);
  const current = useRef({ session, modelId, onSaving }); current.current = { session, modelId, onSaving };
  const previewRef=useRef<string|null>(null);
  const showPreview=(value:string|null)=>{previewRef.current=value;setPreview(value);};
  const saves=useRef<ReturnType<typeof reasoningSaveQueue>|null>(null);
  if(!saves.current) saves.current=reasoningSaveQueue(
    request=>api.setReasoning(request.session,request.modelId,request.effort),{
      busy:value=>{setBusy(value);current.current.onSaving(value,current.current.session);},
      saved:(request,result,hasNext)=>{
        if(current.current.session!==request.session||current.current.modelId!==request.modelId) return;
        setSettings({...result,session:request.session});setError("");
        if(!hasNext&&!dragging.current&&previewRef.current===request.effort) showPreview(null);
      },
      failed:(request,failure,hasNext)=>{
        if(hasNext||current.current.session!==request.session||current.current.modelId!==request.modelId) return;
        setError(readableError(failure));
        if(!dragging.current&&previewRef.current===request.effort) showPreview(null);
      },
    });
  useEffect(() => {
    let cancelled = false; setSettings(null); setError(""); showPreview(null); setDragProgress(null);dragging.current=false;
    if (modelId) void api.reasoning(session).then(value => {
      if (!cancelled && value.modelId === modelId) setSettings({ ...value, session });
    }).catch(error => { if (!cancelled) setError(readableError(error)); });
    return () => { cancelled = true; };
  }, [session, modelId, retry]);
  const valid = settings?.session === session && settings.modelId === modelId;
  const levels = valid ? settings.levels.filter(effort => effort !== "") : [];
  if (!modelId || valid && !levels.length) return null;
  const select = (effort: string) => {
    if (disabled || !valid || !settings.modelId) return;
    if (!saves.current!.busy && effort === settings.effort) {showPreview(null);return;}
    showPreview(effort);setError("");
    saves.current!.enqueue({session,modelId:settings.modelId,effort});
  };
  const effort = preview ?? (valid ? settings.effort : "");
  const stops = ["", ...levels];
  const index = Math.max(0, stops.indexOf(effort));
  const label = valid ? effort ? labels[effort] ?? effort : `默认${settings.default ? ` · ${labels[settings.default] ?? settings.default}` : ""}` : error ? "读取失败" : "读取中…";
  const hint = disabled ? disabledReason || "当前暂不能调整思考强度。" : "";
  const unavailable = disabled || !valid;
  return <section className="composer-reasoning-panel" aria-label="思考强度" aria-busy={busy}>
    <div className="composer-reasoning-heading"><span>思考强度</span><strong aria-live="polite">{label}</strong></div>
    {valid && <>
      <div className="composer-reasoning-track" data-dragging={dragProgress!==null||undefined} data-disabled={unavailable||undefined} style={{"--reasoning-progress":dragProgress??index / (stops.length - 1)} as CSSProperties}>
        <input type="range" min={0} max={stops.length - 1} step={1} value={index} aria-label="思考强度" aria-valuetext={effort ? labels[effort] ?? effort : label} disabled={unavailable}
          onPointerDown={event=>{dragging.current=true;const rect=event.currentTarget.getBoundingClientRect();setDragProgress(Math.max(0,Math.min(1,(event.clientX-rect.left-14)/Math.max(1,rect.width-28))));}}
          onPointerMove={event=>{if(dragging.current){const rect=event.currentTarget.getBoundingClientRect();setDragProgress(Math.max(0,Math.min(1,(event.clientX-rect.left-14)/Math.max(1,rect.width-28))));}}}
          onChange={event => showPreview(stops[Number(event.target.value)] ?? null)}
          onPointerUp={event => {dragging.current=false;setDragProgress(null);void select(stops[Number(event.currentTarget.value)]!);}}
          onPointerCancel={() => {dragging.current=false;setDragProgress(null);showPreview(null);}}
          onKeyUp={event => { if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) void select(stops[Number(event.currentTarget.value)]!); }}
          onBlur={() => {dragging.current=false;setDragProgress(null);if (preview !== null) void select(preview); }}/>
        <span className="composer-reasoning-surface" aria-hidden="true"><span className="composer-reasoning-fill"/>{stops.map((stop,i)=><i className="composer-reasoning-stop" key={stop} data-filled={i<=index||undefined} style={{left:`calc(14px + (100% - 28px) * ${i/(stops.length-1)})`}}/>)}</span>
        <span className="composer-reasoning-thumb" aria-hidden="true"/>
      </div>
      <div className="composer-reasoning-scale" aria-hidden="true"><span>默认</span><span>{labels[levels.at(-1)!] ?? levels.at(-1)}</span></div>
    </> }
    <span className="visually-hidden" role="status">{busy ? "正在保存思考强度" : ""}</span>
    {hint && <p className="composer-reasoning-hint">{hint}</p>}
    {error && <p className="composer-reasoning-error" role="alert">{error}{!valid && <button type="button" onClick={() => setRetry(value => value + 1)}>重试</button>}</p>}
  </section>;
}
