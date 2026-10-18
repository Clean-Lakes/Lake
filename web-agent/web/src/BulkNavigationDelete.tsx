import {Glyph} from './Icons';
import { useState } from "react";
import { api, readableError } from "./api";
import { TrashIcon } from "./NavigationDelete";
import { bulkKindLabel, deleteBulkTargets, type BulkTarget, type BulkDeleteResult } from "./bulkNavigation";

export type BulkSelection = { has: (target: BulkTarget) => boolean; toggle: (target: BulkTarget) => void; disabled: boolean };
export function BulkCheckbox({target, selection}: {target: BulkTarget; selection?: BulkSelection}) {
  if (!selection) return null;
  return <input className="bulk-navigation-checkbox" type="checkbox" aria-label={`选择${bulkKindLabel(target.kind)} ${target.name}`} checked={selection.has(target)} disabled={selection.disabled} onChange={() => selection.toggle(target)} onClick={event => event.stopPropagation()}/>;
}

export function BulkNavigationDelete({targets, onClose, onProcessed, onBusy}: {targets: BulkTarget[]; onClose: () => void; onProcessed: (result: BulkDeleteResult) => Promise<void>; onBusy: (busy: boolean) => void}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BulkDeleteResult | null>(null);
  const [refreshError, setRefreshError] = useState("");
  const remaining = result ? result.failed.map(item => item.target) : targets;
  async function remove() {
    if (busy || !remaining.length) return;
    setBusy(true); onBusy(true); setRefreshError("");
    try {
      const next = await deleteBulkTargets(remaining, target => target.kind === "session" ? api.deleteSession(target.id) : target.kind === "folder" ? api.editResourceTree(target.projectId, {operation: "delete", nodeId: target.id}) : api.deleteNavigation(target.kind, target.id), readableError);
      setResult(next);
      // Record successful deletions before refreshing; a refresh error must never replay them.
      await onProcessed(next);
      if (!next.failed.length) onClose();
    } catch (error) { setRefreshError(`删除结果已记录，但刷新失败：${readableError(error)}`); }
    finally { setBusy(false); onBusy(false); }
  }
  const sessions = remaining.filter(target => target.kind === "session").length;
  return <div className="modal-scrim"><section className="modal bulk-navigation-dialog" role="dialog" aria-modal="true" aria-labelledby="bulk-delete-title">
    <div className="modal-header"><h2 id="bulk-delete-title">{result ? "批量删除结果" : `删除选中的 ${targets.length} 项？`}</h2><button className="icon-button" aria-label="关闭批量删除" disabled={busy} onClick={onClose}><Glyph name="close" size={14}/></button></div>
    {sessions > 0 && <p className="bulk-session-warning">{sessions} 个会话的对话、证据、审批和命令记录将永久删除，不可恢复。</p>}
    <p className="modal-description">资源、文件夹和项目可在“已删除”中恢复。仅删除文件夹时，其中未选中的资源和子文件夹会移到上一级。</p>
    {result && <p role="status">本次已删除 {result.removed.length} 项，失败 {result.failed.length} 项。重试只处理失败项。</p>}
    <ul className="bulk-navigation-targets">{remaining.map(target => <li key={`${target.kind}:${target.id}`}><div><small>{bulkKindLabel(target.kind)}</small><strong>{target.projectName && target.kind !== "project" ? `${target.projectName} / ${target.name}` : target.name}</strong></div>{result?.failed.find(item => item.target === target)?.message && <p className="form-error">{result.failed.find(item => item.target === target)?.message}</p>}</li>)}</ul>
    {refreshError && <p className="form-error" role="alert">{refreshError}</p>}
    <div className="modal-actions"><button className="button secondary" disabled={busy} onClick={onClose}>{result ? "关闭" : "取消"}</button><button className="button danger" disabled={busy || !remaining.length} onClick={() => void remove()}><TrashIcon/>{busy ? "正在删除…" : result ? `重试失败的 ${remaining.length} 项` : `确认删除 ${targets.length} 项`}</button></div>
  </section></div>;
}
