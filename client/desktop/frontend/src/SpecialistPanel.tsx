import { useEffect, useState } from 'react'
import { Plus, RefreshCw, Trash2 } from 'lucide-react'

type Profile = { name: string; description: string; instruction: string; enabled?: boolean; [key: string]: unknown }
type Task = { id: string; name: string; model: string; status: string; checkpoint_available: boolean; resume_available?: boolean; workflow_run_id?: string; scope_json: string; updated_at: string }
type Lake = { id: string; name: string }
const api = () => { const value = window.go?.main?.App; if (!value) throw new Error('桌面桥未就绪'); return value }
const blank = (): Profile => ({ name: 'lake_specialist_', description: '', instruction: '', enabled: false })
const taskScope = (task: Task): { lake_id?: string; project_root?: string } => {
  try { return JSON.parse(task.scope_json) ?? {} } catch { return {} }
}

export default function SpecialistPanel({ onResume }: { onResume: (id: string, retry: boolean) => Promise<void> }) {
  const [profiles, setProfiles] = useState<Profile[]>([]), [lakes, setLakes] = useState<Lake[]>([])
  const [draft, setDraft] = useState<Profile>(blank), [selected, setSelected] = useState(''), [tasks, setTasks] = useState<Task[]>([]), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false)
  const load = async () => {
    const [settings, lakeList, taskList] = await Promise.all([api().Settings('{"action":"get"}'), api().ListLakes(), api().ListSpecialistTasks()])
    setProfiles(JSON.parse(settings).specialists ?? []); setLakes(JSON.parse(lakeList)); setTasks(JSON.parse(taskList))
  }
  useEffect(() => { void load().catch(e => setError(String(e))) }, [])
  const action = async (request: object, message: string) => { setBusy(true); setError(''); setNotice(''); try { await api().Settings(JSON.stringify(request)); await load(); setNotice(message) } catch (e) { setError(String(e)) } finally { setBusy(false) } }
  return <>
    <div className="settings-heading"><div><h1>原生专员</h1><p>设置任务说明和指令。模型、工具和权限沿用当前会话，新任务使用更新后的配置。</p></div><button className="settings-secondary" onClick={() => { setSelected(''); setDraft(blank()) }}><Plus size={15} />添加专员</button></div>
    {error && <div role="alert" className="settings-alert error">{error}</div>}{notice && <div className="settings-alert success">{notice}</div>}
    <div className="settings-split"><div className="settings-list">{profiles.map(p => <button key={p.name} className={p.name === selected ? 'active' : ''} onClick={() => { setSelected(p.name); setDraft(p); setNotice('') }}><span><strong>{p.name}</strong><small>{p.enabled !== false ? '已启用' : '已停用'}</small></span></button>)}</div>
      <div className="settings-card"><label>专员标识<input value={draft.name} disabled={!!selected} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label><label>任务说明<input value={draft.description} onChange={e => setDraft({ ...draft, description: e.target.value })} /></label>
        <label>专员提示词<textarea rows={8} value={draft.instruction} onChange={e => setDraft({ ...draft, instruction: e.target.value })} /></label><label className="settings-check"><input type="checkbox" checked={draft.enabled !== false} onChange={e => setDraft({ ...draft, enabled: e.target.checked })} />启用</label>
        <p className="settings-help">运维工具使用当前会话已授权的湖和资源。已有任务与历史配置继续保留。</p>
        <div className="settings-actions"><button className="primary" disabled={busy} onClick={() => void action({ action: 'specialist_save', specialist: draft }, '专员已保存')}>保存专员</button>{selected && <button className="settings-danger" disabled={busy} onClick={() => { if (window.confirm(`删除 ${selected}？已有任务仍保留。`)) void action({ action: 'specialist_delete', name: selected }, '专员已删除') }}><Trash2 size={15} /></button>}</div>
      </div></div>
    <section className="settings-card"><div className="settings-heading"><h2>最近专员任务</h2><button className="settings-secondary" onClick={() => void load().catch(e => setError(String(e)))}><RefreshCw size={14} />刷新</button></div><p className="settings-help">任务由 ZCode 管理，恢复入口随任务状态显示。旧记录继续保留。</p>{tasks.map(t => <div className="extension-row" key={t.id}><div><strong>{t.name} · {t.status}</strong><span>{lakes.find(l => l.id === taskScope(t).lake_id)?.name ?? '原湖'} · {taskScope(t).project_root ?? ''} · {t.id} · {t.model} · {new Date(t.updated_at).toLocaleString()}</span></div>{t.workflow_run_id && <span>工作流运行 {t.workflow_run_id}；恢复入口在工作流运行记录</span>}{t.status !== 'completed' && t.checkpoint_available && t.resume_available !== false && <div className="settings-actions"><button disabled={busy} onClick={() => void onResume(t.id, false).catch(e => setError(String(e)))}>恢复</button></div>}</div>)}{tasks.length === 0 && <p>暂无任务。</p>}</section>
  </>
}
