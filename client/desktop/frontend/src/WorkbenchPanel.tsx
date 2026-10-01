import { useCallback, useEffect, useState } from 'react'
import { ChevronDown, Code2, FileText, Folder, GitBranch, RefreshCw, SquareTerminal, X } from 'lucide-react'
import './WorkbenchPanel.css'
import { TaskTerminalPanel } from './TaskTerminalPanel'
import type { ExecutionRecord } from './taskTerminal'

type Tab = 'files' | 'git' | 'terminal'
type ReadResult = { path: string; lines: string[]; truncated: boolean }
type GitOverview = { branch: string; files: { path: string; status: string }[]; commits: { hash: string; short: string; subject: string; author: string; date: string }[]; graph: string }
type Tree = { directories: Map<string, Tree>; files: string[] }

function api() {
  const bridge = window.go?.main?.App
  if (!bridge) throw new Error('Lake 桌面桥接尚未就绪')
  return bridge
}

function makeTree(files: string[]): Tree {
  const root: Tree = { directories: new Map(), files: [] }
  for (const file of files) {
    const parts = file.split('/')
    let current = root
    for (const part of parts.slice(0, -1)) {
      if (!current.directories.has(part)) current.directories.set(part, { directories: new Map(), files: [] })
      current = current.directories.get(part)!
    }
    current.files.push(file)
  }
  return root
}

function FileTree({ tree, onSelect, selected }: { tree: Tree; onSelect: (path: string) => void; selected: string }) {
  return <>{[...tree.directories].sort(([a], [b]) => a.localeCompare(b)).map(([name, child]) => <details className="workbench-folder" key={name} open><summary><Folder size={13} />{name}</summary><div className="workbench-folder-content"><FileTree tree={child} onSelect={onSelect} selected={selected} /></div></details>)}{tree.files.sort().map(path => <button className={'workbench-file ' + (selected === path ? 'selected' : '')} key={path} title={path} onClick={() => onSelect(path)}><FileText size={13} />{path.split('/').at(-1)}</button>)}</>
}

export default function WorkbenchPanel({ projectID, projectPath, onClose, conversationID, records, onRun, onQuote, blocked }: { projectID: string; projectPath: string; onClose: () => void; conversationID: string; records: ExecutionRecord[]; onRun: (command: string) => Promise<void>; onQuote: (record: ExecutionRecord) => void; blocked: boolean }) {
  const [tab, setTab] = useState<Tab>('files')
  const [files, setFiles] = useState<string[]>([])
  const [selectedFile, setSelectedFile] = useState('')
  const [fileContent, setFileContent] = useState<ReadResult | null>(null)
  const [git, setGit] = useState<GitOverview | null>(null)
  const [diff, setDiff] = useState('')
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    try {
      setError('')
      if (tab === 'files') setFiles(JSON.parse(await api().ListProjectFiles(projectID)) as string[])
      if (tab === 'git') setGit(JSON.parse(await api().GitOverview(projectID)) as GitOverview)
    } catch (cause) { setError(String(cause)) }
  }, [projectID, tab])

  useEffect(() => { void refresh() }, [refresh])

  async function openFile(path: string) {
    setSelectedFile(path)
    try { setError(''); setFileContent(JSON.parse(await api().ReadProjectFile(projectID, path)) as ReadResult) }
    catch (cause) { setFileContent(null); setError(String(cause)) }
  }
  async function openDiff(path: string) {
    setSelectedFile(path)
    try { setError(''); setDiff(await api().GitDiff(projectID, path)) }
    catch (cause) { setDiff(''); setError(String(cause)) }
  }

  return <aside className="workbench-panel"><header className="workbench-heading"><div><strong>代码工作台</strong><small title={projectPath}>本机 · {projectPath}</small></div><button aria-label="关闭代码工作台" onClick={onClose}><X size={15} /></button></header>
    <nav className="workbench-tabs" aria-label="代码工作台"><button className={tab === 'files' ? 'active' : ''} onClick={() => setTab('files')}><Code2 size={14} />文件</button><button className={tab === 'git' ? 'active' : ''} onClick={() => setTab('git')}><GitBranch size={14} />Git</button><button className={tab === 'terminal' ? 'active' : ''} onClick={() => setTab('terminal')}><SquareTerminal size={14} />终端</button><button title="刷新" aria-label="刷新工作台" onClick={() => void refresh()}><RefreshCw size={13} /></button></nav>
    {error && <div className="workbench-error">{error}</div>}
    <div className="workbench-content">
      {tab === 'files' && <><div className="workbench-section-title">文件树 <span>{files.length}</span></div><div className="workbench-tree"><FileTree tree={makeTree(files)} selected={selectedFile} onSelect={path => void openFile(path)} /></div>{fileContent && <div className="workbench-preview"><strong>{fileContent.path}{fileContent.truncated ? ' · 前 200 行' : ''}</strong><pre>{fileContent.lines.join('\n')}</pre></div>}</>}
      {tab === 'git' && <><div className="workbench-section-title">{git ? <><GitBranch size={13} />{git.branch}</> : 'Git 状态'}</div>{git && <><div className="workbench-git-files">{git.files.length ? git.files.map(file => <button key={file.path} onClick={() => void openDiff(file.path)}><code>{file.status}</code><span>{file.path}</span><ChevronDown size={12} /></button>) : <p>工作区干净</p>}</div>{diff && <div className="workbench-preview"><strong>{selectedFile} · 差异</strong><pre>{diff}</pre></div>}<div className="workbench-section-title">提交图</div><pre className="workbench-graph">{git.graph || '暂无提交'}</pre><div className="workbench-section-title">最近提交</div><ol className="workbench-commits">{git.commits.map(commit => <li key={commit.hash} title={`${commit.author} · ${commit.date}`}><code>{commit.short}</code><span>{commit.subject}</span></li>)}</ol></>}</>}
      {tab === 'terminal' && <TaskTerminalPanel conversationID={conversationID} records={records} onRun={onRun} onQuote={onQuote} blocked={blocked} />}
    </div>
  </aside>
}
