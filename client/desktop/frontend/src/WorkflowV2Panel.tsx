import { useEffect, useState } from 'react'
import { Plus, RefreshCw, X } from 'lucide-react'
import './SettingsPage.css'

type Definition = { id: string; lake_id: string; name: string; description: string; enabled: boolean; revision: number; spec: object }
type Run = { id: string; name: string; revision: number; status: string; created_at: string; nodes: { node_id: string; status: string; error_code?: string }[] }
type Event = { sequence: number; node_id?: string; kind: string; payload: object; created_at: string }
type Preview = { name: string; max_parallel: number; max_expanded: number; estimated_model_calls: number; nodes: { id: string; kind: string; target?: string; permission: string; max_calls: number }[] }
type Props = { lakes: { id: string; name: string }[]; currentLake: string | null; initialDefinitionID?: string; onSaved: () => Promise<void>; projects: { id: string; lake: string; name: string }[]; onClose: () => void; onRun: (lake: string, name: string, request: { definition_id?: string; run_id?: string; project_id?: string; retry_writes: boolean }) => Promise<void> }
const api = () => { const value = window.go?.main?.App; if (!value) throw new Error('桌面桥未就绪'); return value }
const template = JSON.stringify({ version: 2, name: '新工作流', max_parallel: 2, nodes: [{ id: 'inspect', kind: 'tool_call', tool: 'lake_resources', inputs: { lake: { type: 'string', literal: '请填写所属湖名' } }, output_type: 'object' }] }, null, 2)
export default function WorkflowV2Panel({ lakes, currentLake, initialDefinitionID, onSaved, projects, onClose, onRun }: Props) {
  const [lake, setLake] = useState(currentLake ?? lakes[0]?.name ?? ''), [definitions, setDefinitions] = useState<Definition[]>([]), [selected, setSelected] = useState<Definition | null>(null), [source, setSource] = useState(template.replace('请填写所属湖名', currentLake ?? lakes[0]?.name ?? '')), [preview, setPreview] = useState<Preview | null>(null), [runs, setRuns] = useState<Run[]>([]), [selectedRun, setSelectedRun] = useState<Run | null>(null), [events, setEvents] = useState<Event[]>([]), [project, setProject] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const manage = async (request: object) => JSON.parse(await api().WorkflowV2Manage(JSON.stringify(request)))
  const load = async () => { if (!lake) return [] as Definition[]; const [defs, history] = await Promise.all([manage({ action: 'list', lake }), manage({ action: 'runs', lake })]); setDefinitions(defs); setRuns(history); return defs as Definition[] }
  useEffect(() => {
    let current = true
    setSelected(null); setSelectedRun(null); setEvents([]); setProject(''); setPreview(null)
    void load().then(defs => {
      if (!current) return
      const definition = defs.find(item => item.id === initialDefinitionID)
      if (definition) { setSelected(definition); setSource(JSON.stringify(definition.spec, null, 2)) }
    }).catch(e => { if (current) setError(String(e)) })
    return () => { current = false }
  }, [lake, initialDefinitionID])
  const inspectRun = async (id: string) => { const [run, list] = await Promise.all([manage({ action: 'status', lake, id }), manage({ action: 'events', lake, id })]); setSelectedRun(run); setEvents(list) }
  const action = async (mode: string) => { setBusy(true); setError(''); setNotice(''); try { const result = await manage({ action: mode, lake, definition: source, id: selected?.id, expected_revision: selected?.revision }); if (mode === 'validate' || mode === 'preview') { setPreview(result); setNotice(mode === 'validate' ? '定义校验通过' : '目标与权限预览完成') } else { setSelected(result); setSource(JSON.stringify(result.spec, null, 2)); await load(); await onSaved(); setNotice(`已保存修订 ${result.revision}`) } } catch (e) { setError(String(e)) } finally { setBusy(false) } }
  const launch = async (run?: Run, retry = false) => { setError(''); try { if (!run && !selected) return; await onRun(lake, run?.name ?? selected!.name, { definition_id: run ? undefined : selected!.id, run_id: run?.id, project_id: project || undefined, retry_writes: retry }) } catch (e) { setError(String(e)) } }
  const toggleEnabled = async () => {
    if (!selected || busy) return
    setBusy(true); setError('')
    try { const result = await manage({ action: 'enable', lake, id: selected.id, enabled: !selected.enabled }); setSelected(result); await load(); await onSaved() }
    catch (cause) { setError(String(cause)) }
    finally { setBusy(false) }
  }
  return <div className="settings-shell"><header className="settings-top"><strong>工作流 v2</strong><button className="settings-close" aria-label="关闭工作流管理" onClick={onClose}><X size={17} /></button></header><div className="settings-content workflow-v2-content">
    <div className="settings-heading"><div><h1>工作流 v2 管理</h1><p>编辑 JSON 或 YAML 定义，查看节点依赖、权限和模型调用预算。运行与恢复会进入对话，逐项请求批准。</p></div><button className="settings-secondary" onClick={() => { setSelected(null); setSource(template.replace('请填写所属湖名', lake)); setPreview(null) }}><Plus size={15} />新建</button></div>
    <label className="workflow-target"><span>所属湖</span><select value={lake} onChange={e => setLake(e.target.value)}>{lakes.map(l => <option key={l.id}>{l.name}</option>)}</select></label>
    {error && <div role="alert" className="settings-alert error">{error}</div>}{notice && <div className="settings-alert success">{notice}</div>}
    <div className="settings-split"><nav className="settings-list">{definitions.map(d => <button key={d.id} className={selected?.id === d.id ? 'active' : ''} onClick={() => { setSelected(d); setSource(JSON.stringify(d.spec, null, 2)); setPreview(null); setNotice('') }}><span><strong>{d.name}</strong><small>修订 {d.revision} · {d.enabled ? '已启用' : '已停用'}</small></span></button>)}</nav>
      <section className="settings-card"><h2>{selected?.name ?? '新建工作流'}</h2><label>完整定义<textarea className="workflow-v2-source" rows={16} spellCheck={false} value={source} onChange={e => { setSource(e.target.value); setPreview(null) }} /></label><div className="settings-actions"><button disabled={busy} onClick={() => void action('validate')}>校验</button><button disabled={busy} onClick={() => void action('preview')}>目标与权限预览</button><button className="primary" disabled={busy || !lake} onClick={() => void action(selected ? 'amend' : 'save')}>保存{selected ? '新修订' : '定义'}</button>{selected && <button disabled={busy} onClick={() => void toggleEnabled()}>{selected.enabled ? '停用' : '启用'}</button>}</div>
        {preview && <div className="workflow-v2-preview"><p>并发上限 {preview.max_parallel} · 展开调用上限 {preview.max_expanded} · 估算模型调用 {preview.estimated_model_calls}</p><table><thead><tr><th>节点</th><th>类型</th><th>目标</th><th>权限</th><th>调用上限</th></tr></thead><tbody>{preview.nodes.map(n => <tr key={n.id}><td>{n.id}</td><td>{n.kind}</td><td>{n.target ?? '—'}</td><td>{n.permission}</td><td>{n.max_calls}</td></tr>)}</tbody></table></div>}
        <label>运行代码项目<select value={project} onChange={e => setProject(e.target.value)}><option value="">不指定（代码节点使用会话绑定项目）</option>{projects.filter(p => p.lake === lake).map(p => <option value={p.id} key={p.id}>{p.name}</option>)}</select></label><button className="primary" disabled={busy || !selected?.enabled || JSON.stringify(selected.spec, null, 2) !== source} onClick={() => void launch()}>运行已保存修订</button><p className="settings-help">请先保存编辑内容。专员和代码节点执行时仍受资源授权、项目范围与工具白名单约束。</p>
      </section></div>
    <section className="settings-card"><div className="settings-heading"><h2>运行记录</h2><button className="settings-secondary" onClick={() => void load().catch(e => setError(String(e)))}><RefreshCw size={14} />刷新</button></div>{runs.map(r => <div className="extension-row" key={r.id}><button onClick={() => void inspectRun(r.id).catch(e => setError(String(e)))}>{r.name} · 修订 {r.revision} · {r.status}</button><small>{new Date(r.created_at).toLocaleString()}</small></div>)}{runs.length === 0 && <p>暂无运行记录。</p>}
      {selectedRun && <><h3>{selectedRun.id}</h3><div className="settings-actions"><button onClick={() => void inspectRun(selectedRun.id).catch(e => setError(String(e)))}>刷新节点与事件</button>{['interrupted', 'failed', 'waiting_approval'].includes(selectedRun.status) && <><button onClick={() => void launch(selectedRun)}>恢复</button><button onClick={() => { if (window.confirm('已核对外部状态，确认允许重试结果未知的写节点？节点和工具仍需批准。')) void launch(selectedRun, true) }}>核对后重试写节点</button></>}</div><table><thead><tr><th>节点</th><th>状态</th><th>错误</th></tr></thead><tbody>{selectedRun.nodes.map(n => <tr key={n.node_id}><td>{n.node_id}</td><td>{n.status}</td><td>{n.error_code ?? '—'}</td></tr>)}</tbody></table><h3>执行事件</h3><ol className="workflow-v2-events">{events.map(e => <li key={e.sequence}><strong>#{e.sequence} {e.node_id} · {e.kind}</strong><code>{JSON.stringify(e.payload)}</code></li>)}</ol></>}
    </section>
  </div></div>
}
