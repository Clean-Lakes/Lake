import { useCallback, useEffect, useState } from 'react'
import { Code2, FileText, RefreshCw, SquareTerminal, X } from 'lucide-react'
import './WorkbenchPanel.css'
import { TaskTerminalPanel } from './TaskTerminalPanel'
import type { ExecutionRecord } from './taskTerminal'

type RemoteFile = { path: string; content: string; sha256: string }
type RemoteResult = { stdout: string; stderr: string; exit_code: number; truncated: boolean; unknown: boolean; error?: string }

function api() {
  const bridge = window.go?.main?.App
  if (!bridge) throw new Error('Lake 桌面桥接尚未就绪')
  return bridge
}

export default function RemoteWorkbenchPanel({ id, name, location, onClose, conversationID, records, onRun, onQuote, blocked }: { id: string; name: string; location: string; onClose: () => void; conversationID: string; records: ExecutionRecord[]; onRun: (command: string) => Promise<void>; onQuote: (record: ExecutionRecord) => void; blocked: boolean }) {
  const [tab, setTab] = useState<'files' | 'terminal'>('files')
  const [files, setFiles] = useState<string[]>([])
  const [selected, setSelected] = useState<RemoteFile | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState(false)
  const [unknown, setUnknown] = useState(false)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    setError('')
    try { setFiles(JSON.parse(await api().ListRemoteCodeFiles(id)) as string[]) }
    catch (cause) { setError(String(cause)) }
  }, [id])
  useEffect(() => { void refresh() }, [refresh])

  async function openFile(path: string) {
    setPending(true)
    try {
      const file = JSON.parse(await api().ReadRemoteCodeFile(id, path)) as RemoteFile
      setSelected(file); setDraft(file.content); setEditing(false); setUnknown(false); setError('')
    } catch (cause) { setError(String(cause)) }
    finally { setPending(false) }
  }

  async function save() {
    if (!selected || unknown || pending) return
    setPending(true)
    try {
      const result = JSON.parse(await api().WriteRemoteCodeFile(id, selected.path, selected.sha256, draft)) as RemoteResult
      if (result.unknown) { setUnknown(true); setError(result.error || '写入结果未知；请核对远端文件后重新读取') }
      else if (result.exit_code !== 0) setError(result.stderr || `写入失败：退出码 ${result.exit_code}`)
      else await openFile(selected.path)
    } catch (cause) { setError(String(cause)) }
    finally { setPending(false) }
  }


  return <aside className="workbench-panel"><header className="workbench-heading"><div><strong>{name} · 远程代码工作台</strong><small title={location}>{location}</small></div><button aria-label="关闭远程代码工作台" onClick={onClose}><X size={15} /></button></header>
    <nav className="workbench-tabs" aria-label="远程代码工作台"><button className={tab === 'files' ? 'active' : ''} onClick={() => setTab('files')}><Code2 size={14} />文件</button><button className={tab === 'terminal' ? 'active' : ''} onClick={() => setTab('terminal')}><SquareTerminal size={14} />命令</button><button aria-label="刷新远程文件" onClick={() => void refresh()}><RefreshCw size={13} /></button></nav>
    {error && <div className="workbench-error" role="alert">{error}</div>}
    {unknown && <div className="workbench-error" role="status">远端结果未知。先核对远端状态，再重新读取文件或确认继续。<button onClick={() => { setUnknown(false); setError('') }}>我已核对，继续</button></div>}
    <div className="workbench-content">
      {tab === 'files' && <><div className="workbench-section-title">远端文件 <span>{files.length}</span></div><div className="workbench-tree">{files.map(path => <button key={path} className={'workbench-file ' + (selected?.path === path ? 'selected' : '')} title={path} onClick={() => void openFile(path)}><FileText size={13} />{path}</button>)}</div>{selected && <div className="workbench-preview"><strong>{selected.path} · SHA-256 {selected.sha256.slice(0, 12)}…</strong>{editing ? <><textarea className="remote-code-editor" value={draft} onChange={event => setDraft(event.target.value)} aria-label="远端文件内容" /><div className="remote-code-actions"><button disabled={pending || unknown || draft === selected.content} onClick={() => void save()}>按原文件摘要保存</button><button onClick={() => { setDraft(selected.content); setEditing(false) }}>取消</button></div></> : <><pre>{selected.content}</pre><div className="remote-code-actions"><button onClick={() => setEditing(true)}>编辑文件</button></div></>}</div>}</>}
      {tab === 'terminal' && <TaskTerminalPanel conversationID={conversationID} records={records} onRun={onRun} onQuote={onQuote} blocked={blocked} />}
    </div>
  </aside>
}
