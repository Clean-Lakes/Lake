import { useEffect, useRef, useState } from "react";
import type { ReasoningSettings } from "../../shared/contracts";
import { api, readableError } from "./api";
import { AppSelect } from "./AppSelect";
import { Glyph } from "./Icons";

const labels: Record<string, string> = { "": "默认", none: "关闭", minimal: "极低", low: "低", medium: "中", high: "高", xhigh: "极高", max: "最高", ultra: "Ultra" };

export function ReasoningSelector({ session, modelId, disabled, disabledReason, onSaving }: {
  session: string; modelId?: string | null; disabled: boolean; disabledReason?: string; onSaving: (saving: boolean) => void;
}) {
  const [settings, setSettings] = useState<(ReasoningSettings & { session: string }) | null>(null);
  const [open, setOpen] = useState(false), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const current = useRef({ session, modelId }); current.current = { session, modelId };
  useEffect(() => {
    let cancelled = false; setSettings(null); setOpen(false); setError("");
    if (modelId) void api.reasoning(session).then(value => {
      if (!cancelled && value.modelId === modelId) setSettings({ ...value, session });
    }).catch(error => { if (!cancelled) setError(readableError(error)); });
    return () => { cancelled = true; };
  }, [session, modelId]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
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
  const hint = busy ? "正在保存思考级别…" : disabled ? disabledReason || "当前暂不能调整思考级别。" : !valid ? "思考级别读取失败，请重试。" : "";
  return <div className="reasoning-switch-wrap">
    <AppSelect className="composer-model-select composer-reasoning-select" label="思考级别" title={`思考级别：${label}${hint ? ` · ${hint}` : ""}`} icon={<Glyph name="waves" size={16}/>}
      value={valid ? settings.effort : ""} renderValue={label} disabled={disabled || busy || !valid} aria-busy={busy}
      open={open && valid} onOpenChange={setOpen} onChange={event => void select(event.target.value)} popupMinWidth={176}
      popupHeader={<div className="composer-model-heading">思考级别</div>}>
      <option value="">默认{valid && settings.default ? `（${labels[settings.default] ?? settings.default}）` : ""}</option>
      {(valid ? settings.levels : []).filter(effort => effort !== "").map(effort => <option key={effort} value={effort}>{labels[effort] ?? effort}</option>)}
    </AppSelect>
    {error && <p className="reasoning-error" role="alert">{error}</p>}
  </div>;
}
