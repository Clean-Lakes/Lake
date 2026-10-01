import { useEffect, useState } from 'react'
import { Bot, Check, ChevronRight, CircleHelp, Database, Plus, RefreshCw, Server, ShieldCheck, Trash2, X } from 'lucide-react'
import ExtensionPanel from './ExtensionPanel'
import SpecialistPanel from './SpecialistPanel'
import './SettingsPage.css'

type Model = { name: string; provider: string; base_url: string; wire_api: string; has_key: boolean; context_window: number; max_output_tokens: number }
type MCPServer = { name: string; transport: 'stdio' | 'http'; command?: string; args?: string[]; url?: string; enabled: boolean }
type Settings = { current_model: string; models: Model[]; prompts: Record<string, string>; descriptions: Record<string, string>; mcp: MCPServer[] }
type MemoryFact = { id: string; text: string; project_id?: string; source_conversation_id: string; source_event_seq: number; created_at: string }
type MemoryStatus = { lake: string; enabled: boolean; facts: MemoryFact[] }
type Section = 'models' | 'agents' | 'mcp' | 'memory' | 'extensions' | 'specialists'
type ModelDraft = { model: string; provider: string; base_url: string; context_window: number; max_output_tokens: number }
type MCPDraft = { name: string; transport: 'stdio' | 'http'; command: string; args: string; url: string; enabled: boolean }

const api = () => {
  const value = window.go?.main?.App
  if (!value) throw new Error('Lake 桌面桥接尚未就绪')
  return value
}

const emptyModel = (): ModelDraft => ({ model: '', provider: '', base_url: '', context_window: 32000, max_output_tokens: 4096 })
const emptyMCP = (): MCPDraft => ({ name: '', transport: 'stdio', command: '', args: '', url: '', enabled: true })

export default function SettingsPage({ onClose, onModelsChanged, projectPath, onResumeSpecialist }: { onResumeSpecialist: (id: string, retry: boolean) => Promise<void>; onClose: () => void; onModelsChanged: () => void; projectPath: string }) {
  const [section, setSection] = useState<Section>('models')
  const [data, setData] = useState<Settings | null>(null)
  const [selectedModel, setSelectedModel] = useState('')
  const [modelDraft, setModelDraft] = useState<ModelDraft>(emptyModel)
  const [selectedAgent, setSelectedAgent] = useState('lake')
  const [prompt, setPrompt] = useState('')
  const [description, setDescription] = useState('')
  const [selectedMCP, setSelectedMCP] = useState('')
  const [mcpDraft, setMCPDraft] = useState<MCPDraft>(emptyMCP)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [testResult, setTestResult] = useState('')
  const [memory, setMemory] = useState<MemoryStatus | null>(null)

  const load = async () => {
    const result = JSON.parse(await api().Settings(JSON.stringify({ action: 'get' }))) as Settings
    setData(result)
    if (!selectedModel && result.models.length) {
      const first = result.models[0]
      setSelectedModel(first.name)
      setModelDraft({ model: first.name, provider: first.provider, base_url: first.base_url, context_window: first.context_window, max_output_tokens: first.max_output_tokens })
    }
    if (!selectedMCP && result.mcp.length) {
      const first = result.mcp[0]
      setSelectedMCP(first.name)
      setMCPDraft({ name: first.name, transport: first.transport, command: first.command ?? '', args: first.args?.join('\n') ?? '', url: first.url ?? '', enabled: first.enabled })
    }
    if (!data) { setPrompt(result.prompts?.lake ?? ''); setDescription(result.descriptions?.lake ?? '') }
    return result
  }

  useEffect(() => { void load().catch(cause => setError(String(cause))) }, [])

  const loadMemory = async () => {
    const result = JSON.parse(await api().GetMemory()) as MemoryStatus
    setMemory(result)
  }
  useEffect(() => { if (section === 'memory') void loadMemory().catch(cause => setError(String(cause))) }, [section])

  const setMemoryEnabled = async (enabled: boolean) => {
    setBusy(true); setError(''); setNotice('')
    try {
      setMemory(JSON.parse(await api().SetMemoryEnabled(enabled)) as MemoryStatus)
      setNotice(enabled ? '已启用跨会话记忆。' : '已关闭跨会话记忆；已有记录仍可查看和删除。')
    } catch (cause) { setError(String(cause)) }
    finally { setBusy(false) }
  }

  const deleteMemory = async (id: string) => {
    setBusy(true); setError(''); setNotice('')
    try { setMemory(JSON.parse(await api().DeleteMemory(id)) as MemoryStatus); setNotice('记忆已删除。') }
    catch (cause) { setError(String(cause)) }
    finally { setBusy(false) }
  }

  const run = async (request: object, message: string, refresh = true) => {
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await api().Settings(JSON.stringify(request))
      if (refresh) await load()
      setNotice(message)
      return result
    } catch (cause) { setError(String(cause)); return null }
    finally { setBusy(false) }
  }

  const editModel = (item?: Model) => {
    setSelectedModel(item?.name ?? '')
    setModelDraft(item ? { model: item.name, provider: item.provider, base_url: item.base_url, context_window: item.context_window, max_output_tokens: item.max_output_tokens } : emptyModel())
    setError(''); setNotice('')
  }

  const editMCP = (item?: MCPServer) => {
    setSelectedMCP(item?.name ?? '')
    setMCPDraft(item ? { name: item.name, transport: item.transport, command: item.command ?? '', args: item.args?.join('\n') ?? '', url: item.url ?? '', enabled: item.enabled } : emptyMCP())
    setError(''); setNotice(''); setTestResult('')
  }

  const saveModel = async () => {
    if (!modelDraft.model.trim() || !modelDraft.provider.trim() || !modelDraft.base_url.trim()) { setError('请填写模型名、提供方和 Base URL'); return }
    const draft = { ...modelDraft }
    const result = await run({ action: 'model_save', ...draft }, '模型配置已保存；新对话将使用更新后的配置。')
    if (result !== null) { setSelectedModel(draft.model); setModelDraft(draft); onModelsChanged() }
  }

  const saveMCP = async () => {
    try {
      const server = { name: mcpDraft.name.trim(), transport: mcpDraft.transport, command: mcpDraft.command.trim(), args: mcpDraft.args.split('\n').map(v => v.trim()).filter(Boolean), url: mcpDraft.url.trim(), enabled: mcpDraft.enabled }
      if (!server.name) { setError('请填写 MCP 服务名称'); return }
      const result = await run({ action: 'mcp_save', server }, 'MCP 服务已保存；下一次对话启动时加载工具。')
      if (result !== null) { setSelectedMCP(server.name); setTestResult('') }
    } catch (cause) { setError(String(cause)) }
  }

  const agents = [
    { id: 'lake', name: 'Lake Agent', description: '主 Agent · 资源查询、任务分派和运维工作流' },
    { id: 'ssh', name: 'SSH 专员', description: '远程会话、主机巡检和 SSH 命令' },
    { id: 'code', name: '代码专员', description: '代码读取、修改、测试和差异查看' },
  ]

  return <div className="settings-shell">
    <header className="settings-top"><div><button className="settings-back" onClick={onClose} title="返回对话"><ChevronRight size={15} /></button><strong>设置</strong></div><button className="settings-close" onClick={onClose} aria-label="关闭设置"><X size={17} /></button></header>
    <div className="settings-body">
      <nav className="settings-nav" aria-label="设置分类">
        <span>LAKE</span>
        <button className={section === 'models' ? 'active' : ''} onClick={() => setSection('models')}><Database size={16} />模型</button>
        <button className={section === 'agents' ? 'active' : ''} onClick={() => setSection('agents')}><Bot size={16} />内置专员</button>
        <button className={section === 'specialists' ? 'active' : ''} onClick={() => setSection('specialists')}><Bot size={16} />自定义专员</button>
        <button className={section === 'memory' ? 'active' : ''} onClick={() => setSection('memory')}><Database size={16} />记忆</button>
        <span>连接</span>
        <button className={section === 'mcp' ? 'active' : ''} onClick={() => setSection('mcp')}><Server size={16} />MCP 服务器</button>
        <button className={section === 'extensions' ? 'active' : ''} onClick={() => setSection('extensions')}><ShieldCheck size={16} />扩展与权限</button>
      </nav>
      <div className="settings-content">
        {error && <div className="settings-alert error">{error}<button onClick={() => setError('')} aria-label="关闭错误"><X size={14} /></button></div>}
        {notice && <div className="settings-alert success"><Check size={14} />{notice}</div>}
        {section === 'models' && <>
          <div className="settings-heading"><div><h1>模型</h1><p>管理 Lake Agent 使用的模型与提供方。凭据通过本机终端配置，不进入桌面页面。</p></div><button className="settings-secondary" onClick={() => editModel()}><Plus size={15} />添加模型</button></div>
          <div className="settings-split"><div className="settings-list">{data?.models.map(item => <button key={item.name} className={selectedModel === item.name ? 'active' : ''} onClick={() => editModel(item)}><span><strong>{item.name}</strong><small>{item.provider}{data.current_model === item.name ? ' · 当前使用' : ''}</small></span><ChevronRight size={15} /></button>)}{data?.models.length === 0 && <p>暂无模型，点击“添加模型”。</p>}</div>
            <div className="settings-card"><h2>{selectedModel || '添加模型'}</h2><label>模型名称<input autoComplete="off" value={modelDraft.model} onChange={event => setModelDraft({ ...modelDraft, model: event.target.value })} disabled={!!selectedModel} placeholder="例如 mimo-v2.6-pro" /></label><label>提供方标识<input autoComplete="off" value={modelDraft.provider} onChange={event => setModelDraft({ ...modelDraft, provider: event.target.value })} disabled={!!selectedModel} placeholder="例如 mimo" /></label><label>API 格式<input value="Anthropic Messages (/v1/messages)" disabled /></label><label>Base URL<input autoComplete="off" value={modelDraft.base_url} onChange={event => setModelDraft({ ...modelDraft, base_url: event.target.value })} placeholder="https://api.example.com/anthropic" /></label><p className="settings-help">API Key：{data?.models.find(item => item.name === selectedModel)?.has_key ? '已配置' : '未配置'}。请在本机终端运行 lake model login --provider {modelDraft.provider || '提供方名称'}。</p><div className="settings-number-row"><label>上下文窗口<input type="number" min={1024} max={1000000} value={modelDraft.context_window} onChange={event => setModelDraft({ ...modelDraft, context_window: Number(event.target.value) })} /></label><label>最大输出 Token<input type="number" min={1} value={modelDraft.max_output_tokens} onChange={event => setModelDraft({ ...modelDraft, max_output_tokens: Number(event.target.value) })} /></label></div><p className="settings-help">上下文窗口与最大输出 Token 当前为全局值，所有模型共享。</p><div className="settings-actions"><button className="primary" onClick={() => void saveModel()} disabled={busy}>保存配置</button>{selectedModel && <button className="settings-danger" title="移除模型（不删除提供方凭据）" disabled={busy} onClick={async () => { if (window.confirm(`移除模型 ${selectedModel}？`)) { const result = await run({ action: 'model_delete', model: selectedModel }, '模型已移除'); if (result !== null) { editModel(); onModelsChanged() } } }}><Trash2 size={15} /></button>}</div></div>
          </div>
        </>}
        {section === 'agents' && <>
          <div className="settings-heading"><div><h1>内置专员</h1><p>为各 Agent 编写补充提示词。内置的资源校验和审批规则始终生效。</p></div></div>
          <div className="settings-split"><div className="settings-list">{agents.map(agent => <button key={agent.id} className={selectedAgent === agent.id ? 'active' : ''} onClick={() => { setSelectedAgent(agent.id); setPrompt(data?.prompts?.[agent.id] ?? ''); setDescription(data?.descriptions?.[agent.id] ?? ''); setNotice('') }}><span><strong>{agent.name}</strong><small>{data?.descriptions?.[agent.id] || agent.description}</small></span><ChevronRight size={15} /></button>)}</div><div className="settings-card"><h2>{agents.find(item => item.id === selectedAgent)?.name}</h2><p className="settings-help"><CircleHelp size={15} />说明用于 Agent 分派；补充提示词附加在内置规则之后。修改在新对话中生效。</p><label>专员说明<input value={description} onChange={event => setDescription(event.target.value)} placeholder={agents.find(item => item.id === selectedAgent)?.description} /></label><label>补充提示词<textarea value={prompt} onChange={event => setPrompt(event.target.value)} rows={12} placeholder="例如：巡检结果先给结论，再列证据……" /></label><div className="settings-actions"><button className="primary" disabled={busy} onClick={() => void run({ action: 'prompt_save', name: selectedAgent, prompt, description }, '专员信息已保存；新对话生效。')}>保存专员配置</button><button className="settings-secondary" disabled={busy} onClick={() => setPrompt('')}>清空提示词</button></div></div></div>
        </>}
        {section === 'memory' && <>
          <div className="settings-heading"><div><h1>跨会话记忆</h1><p>按当前湖保存你明确要求“记住”的事实。项目记忆只在对应项目中使用。</p></div></div>
          <div className="settings-card settings-memory-card"><h2>{memory?.lake ?? '当前湖'}</h2><p className="settings-help">默认关闭。关闭后已有记录仍可查看和删除，Lake Agent 不会将其加入模型上下文。</p><div className="settings-actions"><button className={memory?.enabled ? 'settings-secondary' : 'primary'} disabled={busy || !memory} onClick={() => void setMemoryEnabled(!memory?.enabled)}>{memory?.enabled ? '关闭记忆' : '启用记忆'}</button><span className="settings-memory-state">{memory?.enabled ? '已启用' : '已关闭'}</span></div><div className="settings-memory-list">{memory?.facts.map(fact => <div className="settings-memory-item" key={fact.id}><div><p>{fact.text}</p><small>{fact.project_id ? '项目记忆' : '湖记忆'} · 来源事件 {fact.source_event_seq}</small></div><button className="settings-memory-delete" title="删除记忆" aria-label={`删除记忆：${fact.text}`} disabled={busy} onClick={() => void deleteMemory(fact.id)}><Trash2 size={15} /></button></div>)}{memory?.facts.length === 0 && <p className="settings-help">暂无记忆。启用后可在对话中输入“请记住：……”保存事实。</p>}</div></div>
        </>}
        {section === 'specialists' && <SpecialistPanel onResume={onResumeSpecialist} />}
        {section === 'extensions' && <ExtensionPanel projectPath={projectPath} />}
        {section === 'mcp' && <>
          <div className="settings-heading"><div><h1>MCP 服务器</h1><p>连接外部工具，Lake Agent 会在新对话启动时发现并使用可用工具。每次调用仍需批准。</p></div><button className="settings-secondary" onClick={() => editMCP()}><Plus size={15} />添加服务器</button></div>
          <div className="settings-split"><div className="settings-list">{data?.mcp.map(item => <button key={item.name} className={selectedMCP === item.name ? 'active' : ''} onClick={() => editMCP(item)}><span><strong>{item.name}</strong><small>{item.transport === 'stdio' ? '本地命令' : 'Streamable HTTP'} · {item.enabled ? '已启用' : '已停用'}</small></span><ChevronRight size={15} /></button>)}{data?.mcp.length === 0 && <p>还没有 MCP 服务器。</p>}</div><div className="settings-card"><h2>{selectedMCP || '添加 MCP 服务器'}</h2><label>名称<input value={mcpDraft.name} disabled={!!selectedMCP} onChange={event => setMCPDraft({ ...mcpDraft, name: event.target.value })} placeholder="例如 filesystem" /></label><label>传输方式<select value={mcpDraft.transport} onChange={event => setMCPDraft({ ...mcpDraft, transport: event.target.value as MCPDraft['transport'] })}><option value="stdio">本地命令（stdio）</option><option value="http">Streamable HTTP</option></select></label>{mcpDraft.transport === 'stdio' ? <><label>启动命令<input value={mcpDraft.command} onChange={event => setMCPDraft({ ...mcpDraft, command: event.target.value })} placeholder="例如 npx 或 /绝对路径/server" /></label><label>参数（每行一个）<textarea value={mcpDraft.args} onChange={event => setMCPDraft({ ...mcpDraft, args: event.target.value })} rows={3} placeholder="-y\n@modelcontextprotocol/server-filesystem" /></label></> : <><label>服务器 URL<input value={mcpDraft.url} onChange={event => setMCPDraft({ ...mcpDraft, url: event.target.value })} placeholder="https://example.com/mcp" /></label></>}<p className="settings-help">MCP 环境变量和请求头请在本机终端使用 lake mcp login 配置。</p><label className="settings-check"><input type="checkbox" checked={mcpDraft.enabled} onChange={event => setMCPDraft({ ...mcpDraft, enabled: event.target.checked })} />启用此服务器</label><div className="settings-actions"><button className="primary" disabled={busy} onClick={() => void saveMCP()}>保存服务器</button>{selectedMCP && <><button className="settings-secondary" disabled={busy} onClick={async () => { setTestResult('正在连接…'); const result = await run({ action: 'mcp_test', name: selectedMCP }, '连接测试完成', false); setTestResult(result ? JSON.parse(result).tools.join('、') || '连接成功，未发现工具' : '') }}><RefreshCw size={14} />测试连接</button><button className="settings-danger" title="删除 MCP 服务器" disabled={busy} onClick={async () => { if (window.confirm(`删除 MCP 服务器 ${selectedMCP}？`)) { const result = await run({ action: 'mcp_delete', name: selectedMCP }, 'MCP 服务器已删除'); if (result !== null) editMCP() } }}><Trash2 size={15} /></button></>}</div>{testResult && <div className="settings-test">{testResult}</div>}</div></div>
        </>}
      </div>
    </div>
  </div>
}
