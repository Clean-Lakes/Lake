import { useCallback, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'

type ExtensionStatus = {
  mcp: { name: string; transport: string; enabled: boolean }[]
  plugins: { name: string; version: string; state: 'enabled' | 'disabled' | 'invalid'; sha256: string; mcp_servers: string[]; hook_declarations: number }[]
  skills: { name: string; scope: string; sha256: string }[]
  hook: { status: 'unbound' | 'absent' | 'disabled' | 'enabled' | 'changed'; sha256?: string; hooks: number }
}

const bridge = () => {
  const app = window.go?.main?.App
  if (!app) throw new Error('Lake 桌面桥接尚未就绪')
  return app
}

export default function ExtensionPanel({ projectPath }: { projectPath: string }) {
  const [status, setStatus] = useState<ExtensionStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const refresh = useCallback(async () => {
    setBusy(true); setError('')
    try { setStatus(JSON.parse(await bridge().ExtensionStatus(projectPath)) as ExtensionStatus) }
    catch (cause) { setError(String(cause)) }
    finally { setBusy(false) }
  }, [projectPath])

  useEffect(() => { void refresh() }, [refresh])

  const togglePlugin = async (name: string, enabled: boolean) => {
    setBusy(true); setError('')
    try { await bridge().SetPluginEnabled(name, enabled); await refresh() }
    catch (cause) { setError(String(cause)); setBusy(false) }
  }

  const toggleHook = async (enabled: boolean) => {
    setBusy(true); setError('')
    try { setStatus(JSON.parse(await bridge().SetWorkspaceHookEnabled(projectPath, enabled)) as ExtensionStatus) }
    catch (cause) { setError(String(cause)) }
    finally { setBusy(false) }
  }

  return <>
    <div className="settings-heading"><div><h1>扩展与权限</h1><p>MCP、Skill、插件和工作区 Hook 的当前状态。启用的 Hook 运行前仍逐次请求批准。</p></div><button className="settings-secondary" disabled={busy} onClick={() => void refresh()}><RefreshCw size={14} />刷新</button></div>
    {error && <div className="settings-alert error">{error}</div>}
    <div className="extension-grid">
      <section className="settings-card"><h2>MCP 服务器</h2><p className="settings-help">工具在新对话启动时发现，调用时请求批准。</p>{status?.mcp.map(item => <div className="extension-row" key={item.name}><strong>{item.name}</strong><span>{item.transport === 'stdio' ? '本地命令' : 'HTTP'} · {item.enabled ? '已启用' : '已停用'}</span></div>)}{status?.mcp.length === 0 && <p className="settings-help">暂无服务器。</p>}</section>
      <section className="settings-card"><h2>Skills</h2><p className="settings-help">只在会话中显式加载；项目 Skill 不自动获得工具权限。</p>{status?.skills.map(item => <div className="extension-row" key={`${item.scope}/${item.name}`}><strong>{item.name}</strong><span>{item.scope} · {item.sha256.slice(0, 12)}</span></div>)}{status?.skills.length === 0 && <p className="settings-help">暂无 Skill。</p>}</section>
      <section className="settings-card"><h2>插件</h2><p className="settings-help">安装后默认关闭。启用后在新会话加载 MCP 与 Hook。MCP 调用和 Hook 命令须批准；停用或摘要变化立即阻断旧会话调用。</p>{status?.plugins.map(item => <div className="extension-row" key={item.name}><div><strong>{item.name}</strong><span>v{item.version} · MCP {item.mcp_servers?.length ?? 0} / Hook {item.hook_declarations ?? 0} · {item.state === 'invalid' ? '校验失败' : item.state === 'enabled' ? '已启用' : '已停用'} · {item.sha256.slice(0, 12)}</span></div><button disabled={busy || item.state === 'invalid'} onClick={() => void togglePlugin(item.name, item.state !== 'enabled')}>{item.state === 'enabled' ? '停用' : '启用'}</button></div>)}{status?.plugins.length === 0 && <p className="settings-help">暂无已安装插件。</p>}</section>
      <section className="settings-card"><h2>工作区 Hooks</h2><p className="settings-help">{projectPath ? `当前项目：${projectPath}` : '当前会话未绑定代码项目。'}</p><div className="extension-row"><div><strong>{status?.hook.status === 'enabled' ? '已启用' : status?.hook.status === 'changed' ? '声明已变化，许可失效' : status?.hook.status === 'disabled' ? '已停用' : status?.hook.status === 'absent' ? '未配置' : '未绑定项目'}</strong>{status?.hook.sha256 && <span>{status.hook.hooks} 个事件 · {status.hook.sha256.slice(0, 12)}</span>}</div>{status?.hook.status !== 'unbound' && status?.hook.status !== 'absent' && <button disabled={busy} onClick={() => void toggleHook(status?.hook.status !== 'enabled')}>{status?.hook.status === 'enabled' ? '停用' : '确认并启用'}</button>}</div></section>
    </div>
  </>
}
