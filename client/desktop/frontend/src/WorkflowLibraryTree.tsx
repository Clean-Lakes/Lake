import { useEffect, useState, type DragEvent, type ReactNode } from 'react'
import { Activity, Check, ChevronDown, ChevronRight, Database, Folder, FolderPlus, GripVertical, Pencil, Play, Plus, Trash2, X } from 'lucide-react'
import { canMoveWorkflow, workflowChildren, workflowDropRequest, workflowEntryKey, type WorkflowDropEdge, type WorkflowLibrary, type WorkflowLibraryEntry, type WorkflowLibraryRequest } from './workflowLibrary'
import './WorkflowLibraryTree.css'

type Props = {
  lakes: { id: string; name: string }[]
  currentLake: string | null
  library: WorkflowLibrary
  disabled: boolean
  onChange: (request: WorkflowLibraryRequest) => Promise<WorkflowLibrary>
  onOpen: (entry: WorkflowLibraryEntry) => void
  onEdit: (entry: WorkflowLibraryEntry) => void
  onRun: (entry: WorkflowLibraryEntry) => void
  onManage: () => void
}
type Editing = { mode: 'create' | 'rename'; lake: string; parentID: string; id?: string; name: string }
type Drop = { key: string; edge: WorkflowDropEdge }
const expansionKey = 'lake.workflow-library.expanded'

function initialExpansion(): Record<string, boolean> {
  try { const saved = JSON.parse(localStorage.getItem(expansionKey) || '{}'); return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {} } catch { return {} }
}

export function WorkflowLibraryTree({ lakes, currentLake, library, disabled, onChange, onOpen, onEdit, onRun, onManage }: Props) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>(initialExpansion)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [dragged, setDragged] = useState<WorkflowLibraryEntry | null>(null)
  const [drop, setDrop] = useState<Drop | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const locked = disabled || saving
  useEffect(() => { if (currentLake) setExpanded(previous => ({ ...previous, [`lake:${currentLake}`]: true })) }, [currentLake])
  useEffect(() => { try { localStorage.setItem(expansionKey, JSON.stringify(expanded)) } catch { /* Keep expansion state in memory when storage is unavailable. */ } }, [expanded])
  const toggle = (key: string) => setExpanded(previous => ({ ...previous, [key]: !previous[key] }))
  const change = async (request: WorkflowLibraryRequest) => {
    if (locked) return
    setSaving(true); setError('')
    try {
      const result = await onChange(request)
      setExpanded(previous => ({ ...previous, [`lake:${request.lake}`]: true, ...(request.parent_id ? { [`folder:${request.parent_id}`]: true } : {}), ...(result.created_id ? { [`folder:${result.created_id}`]: true } : {}) }))
      setEditing(null)
    } catch (cause) { setError(String(cause)) }
    finally { setSaving(false); setDrop(null); setDragged(null) }
  }
  const create = (lake: string, parentID = '') => { setError(''); setEditing({ mode: 'create', lake, parentID, name: '' }); setExpanded(previous => ({ ...previous, [`lake:${lake}`]: true, ...(parentID ? { [`folder:${parentID}`]: true } : {}) })) }
  const editor = () => editing && <form className="workflow-folder-editor" onSubmit={event => { event.preventDefault(); void change({ action: editing.mode === 'create' ? 'create_folder' : 'rename_folder', lake: editing.lake, parent_id: editing.mode === 'create' ? editing.parentID : undefined, id: editing.id, name: editing.name.trim() }) }}>
    <Folder size={13} /><input aria-label="工作流目录名称" autoFocus maxLength={80} placeholder="目录名称" value={editing.name} disabled={saving} onChange={event => setEditing({ ...editing, name: event.target.value })} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); setEditing(null) } }} /><button type="submit" aria-label="保存工作流目录" disabled={locked || !editing.name.trim()}><Check size={13} /></button><button type="button" aria-label="取消目录编辑" disabled={saving} onClick={() => setEditing(null)}><X size={13} /></button>
  </form>
  const edgeAt = (event: DragEvent<HTMLDivElement>, entry: WorkflowLibraryEntry): WorkflowDropEdge => {
    const box = event.currentTarget.getBoundingClientRect()
    const ratio = (event.clientY - box.top) / box.height
    return entry.kind === 'folder' ? ratio < .25 ? 'before' : ratio > .75 ? 'after' : 'inside' : ratio < .5 ? 'before' : 'after'
  }
  const rows = (lakeID: string, parentID: string, ancestry: Set<string> = new Set()): ReactNode => workflowChildren(library.entries, lakeID, parentID).map(entry => {
    const key = workflowEntryKey(entry)
    const folder = entry.kind === 'folder'
    const open = expanded[key] === true
    const nextAncestry = new Set(ancestry).add(entry.id)
    return <div key={key} className="workflow-library-branch">
      <div className={`workflow-library-row ${folder ? 'is-folder' : ''} ${dragged && workflowEntryKey(dragged) === key ? 'dragging' : ''} ${drop?.key === key ? `drop-${drop.edge}` : ''}`} data-workflow-key={key} draggable={!locked && !editing} onDragStart={event => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-lake-workflow', key); setDragged(entry); setError('') }} onDragEnd={() => { setDragged(null); setDrop(null) }} onDragOver={event => {
        event.stopPropagation()
        if (!dragged || locked) return
        const edge = edgeAt(event, entry)
        if (!workflowDropRequest(library.entries, dragged, entry, edge)) { event.dataTransfer.dropEffect = 'none'; setDrop(null); return }
        event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDrop({ key, edge })
      }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDrop(previous => previous?.key === key ? null : previous) }} onDrop={event => {
        event.preventDefault(); event.stopPropagation()
        if (!dragged || locked) return
        const request = workflowDropRequest(library.entries, dragged, entry, edgeAt(event, entry))
        if (request) void change(request)
      }}>
        <span className="workflow-grip" aria-hidden="true"><GripVertical size={12} /></span>
        <button className="workflow-library-open" title={folder ? `${entry.name} · 拖到中间移入，上下边缘排序` : entry.description || entry.name} aria-expanded={folder ? open : undefined} onClick={() => folder ? toggle(key) : onOpen(entry)}>
          {folder && (open ? <ChevronDown size={12} /> : <ChevronRight size={12} />)}{folder ? <Folder size={14} /> : <Activity size={14} />}<span>{entry.name}</span>{entry.kind === 'v2' && <small>v2</small>}
        </button>
        {folder ? <div className="workflow-library-actions"><button disabled={locked} aria-label={`在${entry.name}中新建目录`} title="新建子目录" onClick={() => create(entry.lake, entry.id)}><Plus size={12} /></button><button disabled={locked} aria-label={`重命名目录${entry.name}`} title="重命名目录" onClick={() => setEditing({ mode: 'rename', lake: entry.lake, parentID: entry.parent_id, id: entry.id, name: entry.name })}><Pencil size={11} /></button><button disabled={locked} aria-label={`删除目录${entry.name}`} title="删除空目录" onClick={() => void change({ action: 'delete_folder', lake: entry.lake, id: entry.id })}><Trash2 size={11} /></button></div> : <div className="workflow-library-actions"><button disabled={locked} aria-label={`修改${entry.name}`} title="修改工作流" onClick={() => onEdit(entry)}><Pencil size={11} /></button><button className="workflow-library-run" disabled={locked || !entry.enabled} aria-label={`运行${entry.name}`} title={entry.enabled ? '运行工作流' : '工作流已停用'} onClick={() => onRun(entry)}><Play size={12} /></button></div>}
      </div>
      {editing?.mode === 'rename' && editing.id === entry.id && editor()}
      {folder && open && !ancestry.has(entry.id) && <div className="workflow-library-children">{rows(lakeID, entry.id, nextAncestry)}{editing?.mode === 'create' && editing.parentID === entry.id && editor()}{workflowChildren(library.entries, lakeID, entry.id).length === 0 && editing?.parentID !== entry.id && <div className="workflow-folder-empty">拖入工作流或目录</div>}</div>}
    </div>
  })
  return <section className="workflow-library" aria-label="工作流目录树">
    <div className="nav-label resource-heading"><span>运维工作流 <em>{library.entries.filter(entry => entry.kind !== 'folder').length}</em></span><button disabled={locked || !currentLake} title="新建工作流目录" aria-label="新建工作流目录" onClick={() => currentLake && create(currentLake)}><FolderPlus size={15} /></button><button disabled={locked} title="管理工作流 v2" aria-label="管理工作流 v2" onClick={onManage}><Plus size={15} /></button></div>
    {error && <div className="workflow-library-error" role="alert">{error}</div>}
    {lakes.map(lake => <div className="tree-group" key={lake.id}>
      <div className={`tree-heading workflow-library-root ${drop?.key === `lake:${lake.name}` ? 'drop-inside' : ''}`} data-workflow-lake={lake.id} onDragOver={event => { event.stopPropagation(); if (!locked && dragged && canMoveWorkflow(library.entries, dragged, lake.id, '')) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDrop({ key: `lake:${lake.name}`, edge: 'inside' }) } else { event.dataTransfer.dropEffect = 'none'; setDrop(null) } }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDrop(null) }} onDrop={event => { event.preventDefault(); event.stopPropagation(); if (dragged && canMoveWorkflow(library.entries, dragged, lake.id, '')) void change({ action: 'move', lake: lake.name, kind: dragged.kind, id: dragged.id, parent_id: '' }) }}>
        <button className="folder-row" aria-expanded={expanded[`lake:${lake.name}`] === true} onClick={() => toggle(`lake:${lake.name}`)}><span className="folder-chevron">{expanded[`lake:${lake.name}`] ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span><Database size={14} /><span className="folder-name">{lake.name}</span><em>{library.entries.filter(entry => entry.lake_id === lake.id && entry.kind !== 'folder').length}</em></button><button className="folder-add" disabled={locked} aria-label={`在${lake.name}中新建工作流目录`} title="新建目录" onClick={() => create(lake.name)}><FolderPlus size={14} /></button>
      </div>
      {expanded[`lake:${lake.name}`] && <div className="tree-children workflow-library-tree">{rows(lake.id, '')}{editing?.mode === 'create' && editing.lake === lake.name && editing.parentID === '' && editor()}{library.entries.every(entry => entry.lake_id !== lake.id) && editing?.lake !== lake.name && <div className="empty-inline nested">暂无工作流，可新建目录</div>}</div>}
    </div>)}
  </section>
}
