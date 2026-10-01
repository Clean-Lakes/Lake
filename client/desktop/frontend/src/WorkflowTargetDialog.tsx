import { useEffect, useId, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { Activity, Check, Database, Play, Search, Server, X } from 'lucide-react'
import './WorkflowTargetDialog.css'

type Host = {
  id: string
  name: string
  kind: string
  execute_authz: boolean
  ssh?: { username: string; host: string; port: number }
}
type Props = {
  workflow: { name: string; lake: string; spec: { steps: { resource: string }[] } }
  mode: 'fixed' | 'single' | 'multiple' | 'bindings'
  resources: Host[]
  targets: Record<string, string>
  selectedHosts: string[]
  setTargets: Dispatch<SetStateAction<Record<string, string>>>
  setSelectedHosts: Dispatch<SetStateAction<string[]>>
  busy: boolean
  onClose: () => void
  onRun: () => void
}

export default function WorkflowTargetDialog({ workflow, mode, resources, targets, selectedHosts, setTargets, setSelectedHosts, busy, onClose, onRun }: Props) {
  const id = useId()
  const dialog = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const hosts = resources.filter(resource => resource.kind === 'host')
  const keys = [...new Set(workflow.spec.steps.map(step => step.resource.replace(/^\$/, '')))]
  const multiple = mode === 'multiple'
  const stepCount = workflow.spec.steps.length
  const limit = Math.floor(32 / Math.max(1, stepCount))
  const selected = multiple ? selectedHosts : keys.map(key => targets[key]).filter(Boolean)
  const selectedCount = new Set(selected).size
  const validTargets = selected.length > 0 && selected.every(name => hosts.some(host => host.name === name && host.execute_authz))
  const canRun = !busy && validTargets && (multiple ? selectedHosts.length <= limit : keys.every(key => !!targets[key]))
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visibleHosts = hosts.filter(host => `${host.name} ${host.ssh?.username ?? ''} ${host.ssh?.host ?? ''}`.toLocaleLowerCase().includes(normalizedQuery))
  const hostCount = normalizedQuery ? `${visibleHosts.length} / ${hosts.length} 台` : `${hosts.length} 台`

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const node = dialog.current
    const first = node?.querySelector<HTMLInputElement>('input:checked:not(:disabled)') ?? node?.querySelector<HTMLInputElement>('input:not(:disabled)') ?? node?.querySelector<HTMLButtonElement>('button')
    first?.focus()
    return () => { if (previousFocus?.isConnected) previousFocus.focus() }
  }, [])

  const renderHosts = (key: string) => <div className="workflow-launch-hosts">
    {visibleHosts.map(host => {
      const checked = multiple ? selectedHosts.includes(host.name) : targets[key] === host.name
      const atLimit = multiple && !checked && selectedHosts.length >= limit
      const disabled = !host.execute_authz || atLimit
      return <label className={`workflow-launch-host${checked ? ' selected' : ''}${disabled ? ' disabled' : ''}`} key={host.id}>
        <input type={multiple ? 'checkbox' : 'radio'} name={`${id}-${key}`} value={host.name} checked={checked} disabled={disabled} aria-label={`选择主机 ${host.name}`} onChange={event => {
          const isChecked = event.currentTarget.checked
          if (multiple) setSelectedHosts(previous => {
            if (!isChecked) return previous.filter(name => name !== host.name)
            return previous.includes(host.name) || previous.length >= limit ? previous : [...previous, host.name]
          })
          else setTargets(previous => ({ ...previous, [key]: host.name }))
        }} />
        <span className="workflow-launch-host-icon" aria-hidden="true"><Server size={19} strokeWidth={1.6} /></span>
        <span className="workflow-launch-host-info"><strong>{host.name}</strong><small>{host.ssh ? `${host.ssh.username}@${host.ssh.host}:${host.ssh.port}` : 'SSH 主机'}</small></span>
        <span className={`workflow-launch-auth${host.execute_authz ? '' : ' unauthorized'}`}><i aria-hidden="true" />{host.execute_authz ? '已授权' : '未授权'}</span>
        <span className={`workflow-launch-selection${multiple ? ' checkbox' : ''}`} aria-hidden="true">{checked && <Check size={12} strokeWidth={2.8} />}</span>
      </label>
    })}
  </div>

  return <div className="workflow-launch-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <div className="workflow-launch-dialog" ref={dialog} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
      if (event.key !== 'Tab') return
      const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') ?? [])]
      if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus() }
      else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus() }
    }}>
      <header className="workflow-launch-header">
        <span className="workflow-launch-icon" aria-hidden="true"><Activity size={20} strokeWidth={1.6} /></span>
        <div><h2 id={`${id}-title`}>选择运行资源</h2><p>{workflow.name}</p></div>
        <button type="button" className="workflow-launch-close" aria-label="关闭资源选择" onClick={onClose}><X size={18} /></button>
      </header>
      <div className="workflow-launch-context"><span><Database size={13} aria-hidden="true" />{workflow.lake}</span><i aria-hidden="true" /><span>{stepCount} 个步骤</span><i aria-hidden="true" /><span>{multiple ? '多选主机' : keys.length > 1 ? '资源映射' : '单选主机'}</span></div>
      <div className="workflow-launch-body">
        <p className="workflow-launch-description" id={`${id}-description`}>{multiple ? `每台主机都将执行完整工作流，最多选择 ${limit} 台。` : '选择本次工作流的目标主机。'}</p>
        {hosts.length > 6 && <label className="workflow-launch-search"><Search size={15} aria-hidden="true" /><input type="search" aria-label="搜索主机" placeholder="搜索名称或 SSH 地址" value={query} onChange={event => setQuery(event.target.value)} />{query && <button type="button" aria-label="清空搜索" onClick={() => setQuery('')}><X size={13} /></button>}</label>}
        {hosts.length === 0 ? <div className="workflow-launch-empty"><Server size={25} strokeWidth={1.4} /><strong>暂无可选主机</strong><span>在「{workflow.lake}」中添加 SSH 主机后即可选择。</span></div> : visibleHosts.length === 0 ? <div className="workflow-launch-empty"><Search size={24} strokeWidth={1.4} /><strong>没有匹配的主机</strong><span>试试其他名称或地址。</span></div> : multiple ? <fieldset className="workflow-launch-group"><legend>目标主机<span>{hostCount}</span></legend>{renderHosts('hosts')}</fieldset> : keys.map(key => <fieldset className="workflow-launch-group" key={key}><legend>{keys.length === 1 ? '目标主机' : `目标资源 · ${key}`}<span>{hostCount}</span></legend>{renderHosts(key)}</fieldset>)}
        {hosts.some(host => !host.execute_authz) && <p className="workflow-launch-hint">未授权主机需先开启执行授权。</p>}
      </div>
      <footer className="workflow-launch-footer">
        <span className="workflow-launch-summary" aria-live="polite">{selectedCount ? <>已选 <strong>{selectedCount}</strong> 台主机</> : '尚未选择主机'}</span>
        <div><button type="button" className="workflow-launch-cancel" onClick={onClose}>取消</button><button type="button" className="workflow-launch-run" disabled={!canRun} onClick={onRun}><Play size={13} fill="currentColor" strokeWidth={1.5} />运行工作流</button></div>
      </footer>
    </div>
  </div>
}
