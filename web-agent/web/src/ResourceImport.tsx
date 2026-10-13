import {useEffect, useRef, useState} from "react";
import type {Project, ResourceImportPreview, ResourceImportRow} from "../../shared/contracts";
import {api, readableError} from "./api";
import {readTextFile} from "./textFiles";

export function ImportResourceRows({rows, selected, onSelect, disabled = false}: {rows: ResourceImportRow[]; selected?: number[]; onSelect?: (index:number, checked:boolean) => void; disabled?: boolean}) {
  return <div className="resource-import-rows">{rows.map(row => <label className={`resource-import-row ${row.error ? "invalid" : ""}`} key={row.index}>
    {onSelect && <input type="checkbox" checked={selected?.includes(row.index) ?? false} disabled={disabled || !!row.error} onChange={event => onSelect(row.index,event.target.checked)}/>}
    <span><strong>{row.name || "未命名资源"}</strong><small>{[row.kind, row.username, row.host && `${row.host}${row.port ? `:${row.port}` : ""}`, row.endpoint, row.folder && `目录：${row.folder}`].filter(Boolean).join(" · ")}</small>{row.error ? <em>{row.error}</em> : row.hasCredential ? <small>凭据已安全读取</small> : row.kind === "ssh" && <small>缺少登录信息，导入后可在资源编辑中补充</small>}</span>
  </label>)}</div>;
}
export function ResourceImport({project, hexhub, refresh, onClose, onImported}: {project:Project; hexhub?:boolean; refresh:() => Promise<unknown>; onClose:() => void; onImported:(message:string) => void}) {
  const input = useRef<HTMLInputElement>(null);
  const [name,setName] = useState("文本资源配置");
  const [text,setText] = useState("");
  const [preview,setPreview] = useState<ResourceImportPreview | null>(null);
  const [selected,setSelected] = useState<number[]>([]);
  const [busy,setBusy] = useState("");
  const [error,setError] = useState("");
  const inspect = async (fileName:string, content:string) => {
    setBusy("识别中…"); setError(""); setPreview(null);
    try { const data=await api.previewResourceImport(project.id,fileName,content); setPreview(data); setSelected(data.resources.filter(row => !row.error).map(row => row.index)); }
    catch(error) {setError(readableError(error));} finally {setBusy("");}
  };
  const fromHexhub = async () => {
    setBusy("读取 HexHub 资产…"); setError(""); setPreview(null);
    try { const data=await api.previewHexhubImport(project.id); setPreview(data); setSelected(data.resources.filter(row => !row.error).map(row => row.index)); }
    catch(error) {setError(readableError(error));} finally {setBusy("");}
  };
  useEffect(() => { if (hexhub) void fromHexhub(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const file = async (value:File | undefined) => {
    if (!value) return;
    try { const content=await readTextFile(value); setName(value.name); setText(""); await inspect(value.name,content); }
    catch(error) {setError(readableError(error));}
    if(input.current)input.current.value="";
  };
  const commit = async () => {
    if (!preview) return; setBusy("导入中…");setError("");
    try { const result=await api.importResources(project.id,preview.planId,selected); await refresh(); onImported(`已导入 ${result.createdCount} 个资源，同步 ${result.updatedCount || 0} 个已有连接的登录信息，跳过 ${result.skippedCount} 个已有连接`); onClose(); }
    catch(error) {setError(readableError(error));} finally {setBusy("");}
  };
  return <div className="modal-scrim"><section className="modal resource-import-dialog" role="dialog" aria-modal="true" aria-label="导入资源"><div className="modal-header"><h2>导入资源</h2><button type="button" className="button secondary" disabled={!!busy} onClick={onClose}>关闭</button></div>
    <p>导入到「{project.name}」。支持任意扩展名的文本文件、JSON、CSV、SSH 配置和文字说明，也可直接读取本机 HexHub 的连接清单。自动读取已保存的登录信息，补齐已有连接的缺失配置；完整连接会跳过。</p>
    <input className="visually-hidden" type="file" ref={input} onChange={event => void file(event.target.files?.[0])}/><button type="button" className="button secondary" disabled={!!busy} onClick={() => input.current?.click()}>选择文本文件</button> <button type="button" className="button secondary" disabled={!!busy} onClick={() => void fromHexhub()}>从 HexHub 导入</button>
    {!preview && <><label>或粘贴连接配置<textarea aria-label="连接配置文本" rows={6} value={text} disabled={!!busy} onChange={event => setText(event.target.value)} placeholder="粘贴服务器清单、JSON、CSV 或连接说明…"/></label><button type="button" className="button primary" disabled={!!busy || !text.trim()} onClick={() => void inspect(name,text)}>识别资源</button></>}
    {preview && <>{preview.notice && <p role="status">{preview.notice}</p>}<p>{preview.name} · 识别到 {preview.resources.length} 条，已选择 {selected.length} 条</p><div className="resource-import-selection"><button type="button" className="button secondary" disabled={!!busy || preview.resources.filter(row => !row.error).every(row => selected.includes(row.index))} onClick={() => setSelected(preview.resources.filter(row => !row.error).map(row => row.index))}>全选</button><button type="button" className="button secondary" disabled={!!busy || !selected.length} onClick={() => setSelected([])}>全不选</button><small>有错误的条目不参与全选</small></div><ImportResourceRows disabled={!!busy} rows={preview.resources} selected={selected} onSelect={(index,checked) => setSelected(values => checked ? [...new Set([...values,index])] : values.filter(value => value!==index))}/><div className="resource-import-actions"><button type="button" className="button secondary" disabled={!!busy} onClick={() => {setPreview(null);setSelected([]);}}>重新选择</button><button type="button" className="button primary" disabled={!!busy || !selected.length} onClick={() => void commit()}>导入 {selected.length} 个资源</button></div></>}
    {busy && <p role="status">{busy}</p>}{error && <p className="form-error" role="alert">{error}</p>}
  </section></div>;
}
