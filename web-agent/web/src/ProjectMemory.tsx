import {Glyph} from './Icons';
import {DisclosureSummary} from './DisclosureSummary';
import {AppSelect} from "./AppSelect";
import {useEffect, useState} from "react";
import type {Project, ProjectMemoryEntry, ProjectMemoryList, ProjectMemoryJob} from "../../shared/contracts";
import {api, readableError} from "./api";
import "./projectMemory.css";

const empty = {key:"", type:"project" as ProjectMemoryEntry["type"], description:"", body:"", revision:0, validUntil:"", restoreDeleted:false};

export function ProjectMemory({project, onClose}: {project:Project; onClose:()=>void}) {
  const [list, setList] = useState<ProjectMemoryList | null>(null);
  const [jobs, setJobs] = useState<ProjectMemoryJob[]>([]);
  const [query, setQuery] = useState("");
  const [includeExpired, setIncludeExpired] = useState(false);
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<typeof empty | null>(null);
  const [selectedSources, setSelectedSources] = useState<ProjectMemoryEntry["sources"]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setList(null); setSelected(null); setError("");
    api.projectMemories(project.id, query, includeExpired, includeDeleted, offset, controller.signal).then(setList).catch(err => {if (!controller.signal.aborted) setError(readableError(err));});
    api.projectMemoryJobs(project.id).then(result => {if (!controller.signal.aborted) setJobs(result.items);}).catch(() => {});
    return () => controller.abort();
  }, [project.id, query, includeExpired, includeDeleted, offset]);
  async function refresh() {
    const [newList, newJobs] = await Promise.all([api.projectMemories(project.id, query, includeExpired, includeDeleted, offset), api.projectMemoryJobs(project.id)]);
    setList(newList); setJobs(newJobs.items);
  }
  async function open(entry: ProjectMemoryEntry) {
    setError("");
    try {
      const full = await api.projectMemory(project.id, entry.key, !!entry.deletedAt);
      setSelected({key:full.key, type:full.type || "project", description:full.description || "", body:full.body || "", revision:full.revision, validUntil:full.validUntil || "", restoreDeleted:!!full.deletedAt});
      setSelectedSources(full.sources || []);
    } catch (err) { setError(readableError(err)); }
  }
  async function save() {
    if (!selected) return;
    setBusy(true); setError("");
    try {
      await api.saveProjectMemory(project.id, selected.key, {type:selected.type, description:selected.description, body:selected.body, expectedRevision:selected.revision, validUntil:selected.validUntil, restoreDeleted:selected.restoreDeleted});
      setSelected(null); await refresh();
    } catch (err) { setError(readableError(err)); }
    finally { setBusy(false); }
  }
  async function forget() {
    if (!selected || !window.confirm(`忘记「${selected.description || selected.key}」？`)) return;
    setBusy(true); setError("");
    try { await api.forgetProjectMemory(project.id, selected.key, selected.revision); setSelected(null); await refresh(); }
    catch (err) { setError(readableError(err)); }
    finally { setBusy(false); }
  }
  async function settings(useEnabled: boolean, extractionEnabled: boolean) {
    if (!list) return;
    setBusy(true); setError("");
    try { await api.setProjectMemorySettings(project.id, useEnabled, extractionEnabled, list.settings.settingsRevision); await refresh(); }
    catch (err) { setError(readableError(err)); }
    finally { setBusy(false); }
  }
  async function retry(jobId: string) {
    if (!list) return;
    setBusy(true); setError("");
    try { await api.retryProjectMemoryJob(project.id, jobId, list.projectRevision); await refresh(); }
    catch (err) { setError(readableError(err)); }
    finally { setBusy(false); }
  }
  return <div className="modal-scrim project-memory-scrim" onMouseDown={event => {if (event.target === event.currentTarget) onClose();}}><section className="modal project-memory-modal" role="dialog" aria-modal="true" aria-label={`${project.name} 的项目记忆`}>
    <div className="modal-header"><h2>{project.name} · 项目记忆</h2><button className="icon-button" aria-label="关闭项目记忆" onClick={onClose}><Glyph name="close" size={14}/></button></div>
    <p className="modal-description">同项目会话共享这些记忆。自动提取在回复完成后运行；可在此查看、编辑或停用。</p>
    {list && <div className="project-memory-settings"><label><input type="checkbox" checked={list.settings.useEnabled} disabled={busy} onChange={event => void settings(event.target.checked, list.settings.extractionEnabled)}/>会话使用项目记忆</label><label><input type="checkbox" checked={list.settings.extractionEnabled} disabled={busy} onChange={event => void settings(list.settings.useEnabled, event.target.checked)}/>从新对话自动提取</label></div>}
    <div className="project-memory-toolbar"><input aria-label="搜索项目记忆" placeholder="搜索名称或描述" value={query} onChange={event => {setOffset(0);setQuery(event.target.value);}}/><label><input type="checkbox" checked={includeExpired} onChange={event => {setOffset(0);setIncludeExpired(event.target.checked);}}/>显示过期</label><label><input type="checkbox" checked={includeDeleted} onChange={event => {setOffset(0);setIncludeDeleted(event.target.checked);}}/>显示已忘记</label><button type="button" className="button secondary" onClick={() => {setSelected({...empty});setSelectedSources([]);}}>新增</button></div>
    {error && <p className="form-error" role="alert">{error} {error.includes("冲突") || error.includes("changed") ? <button type="button" onClick={() => void refresh()}>刷新</button> : null}</p>}
    <div className="project-memory-list">{!list ? <p>正在加载…</p> : list.items.length ? list.items.map(entry => <button key={entry.key} type="button" onClick={() => void open(entry)}><strong>{entry.description || entry.key}</strong><small>{entry.key} · {entry.deletedAt ? "已忘记" : entry.type} · {entry.expired ? "已过期 · " : ""}{new Date(entry.updatedAt || entry.deletedAt).toLocaleString()}</small></button>) : <p>暂无项目记忆</p>}</div>
    {list && list.total > 50 && <div className="project-memory-pages"><button type="button" disabled={offset===0} onClick={() => setOffset(Math.max(0,offset-50))}>上一页</button><span>{offset+1}–{Math.min(offset+50,list.total)} / {list.total}</span><button type="button" disabled={offset+50>=list.total} onClick={() => setOffset(offset+50)}>下一页</button></div>}
    {selected && <div className="project-memory-editor"><h3>{selected.restoreDeleted ? "恢复已忘记的记忆" : selected.revision ? "编辑记忆" : "新增记忆"}</h3><small>当前版本 {selected.revision}</small><label>键<input value={selected.key} disabled={selected.revision > 0} placeholder="short-kebab-case" onChange={event => setSelected({...selected, key:event.target.value})}/></label><label>类型<AppSelect value={selected.type} onChange={event => setSelected({...selected, type:event.target.value as ProjectMemoryEntry["type"]})}>{["project","user","feedback","reference"].map(type => <option key={type} value={type}>{type}</option>)}</AppSelect></label><label>描述<input value={selected.description} maxLength={160} onChange={event => setSelected({...selected, description:event.target.value})}/></label><label>正文<textarea value={selected.body} rows={5} onChange={event => setSelected({...selected, body:event.target.value})}/></label><label>有效期（可选，RFC3339）<input value={selected.validUntil} onChange={event => setSelected({...selected, validUntil:event.target.value})}/></label>{selectedSources?.length ? <p className="project-memory-source">来源：{selectedSources.map(source => `${source.kind} · ${new Date(source.at).toLocaleString()}`).join("；")}</p> : null}<div className="modal-actions">{selected.revision > 0 && !selected.restoreDeleted && <button className="button danger" disabled={busy} onClick={() => void forget()}>忘记</button>}<button className="button secondary" onClick={() => setSelected(null)}>取消</button><button className="button primary" disabled={busy || !selected.key || !selected.description || !selected.body} onClick={() => void save()}>{selected.restoreDeleted ? "明确恢复" : "保存"}</button></div></div>}
    <details className="project-memory-jobs"><DisclosureSummary>自动提取任务（{jobs.length}）</DisclosureSummary>{jobs.length ? jobs.map(job => <p key={job.jobId}>{new Date(job.createdAt).toLocaleString()} · {job.status}{job.lastErrorCode ? ` · ${job.lastErrorCode}` : ""} {(["blocked","failed","skipped"].includes(job.status) && list?.settings.useEnabled && list?.settings.extractionEnabled) && <button type="button" disabled={busy} onClick={() => void retry(job.jobId)}>重试</button>}</p>) : <p>暂无任务</p>}</details>
  </section></div>;
}
