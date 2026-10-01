import { useEffect, useMemo, useState } from 'react'
import { Database, RefreshCw, ShieldCheck, Wifi, WifiOff } from 'lucide-react'
import { ConversationMessages } from '../../desktop/frontend/src/shared/ConversationMessages'
import { ConversationOpen, type ConversationSummary } from '../../desktop/frontend/src/shared/ConversationOpen'
import { ApprovalCard } from '../../desktop/frontend/src/shared/ApprovalCard'
import { ModelStatus } from '../../desktop/frontend/src/shared/ModelStatus'
import { useConversationStream } from './useConversationStream'

type Conversation = ConversationSummary & { lake_id: string; updated_at: string; project_path?: string; remote_workspace_id?: string; remote_root?: string; remote_host?: string; remote_username?: string; remote_port?: number }

export default function App() {
  const [token, setToken] = useState('')
  const [tokenDraft, setTokenDraft] = useState('')
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [selected, setSelected] = useState('')
  const [listError, setListError] = useState('')
  const [revision, setRevision] = useState(0)
  const stream = useConversationStream(selected, token)
  useEffect(() => {
    let live = true
    fetch('/api/v1/conversations', { headers: token ? { Authorization: `Bearer ${token}` } : {}, cache: 'no-store' })
      .then(async response => { if (!response.ok) throw new Error(response.status === 401 ? '输入 Web 令牌后连接' : `会话列表读取失败（${response.status}）`); return response.json() as Promise<Conversation[]> })
      .then(items => { if (!live) return; setConversations(items); setListError(''); setSelected(current => items.some(item => item.id === current) ? current : items[0]?.id ?? '') })
      .catch(error => { if (live) setListError(String(error instanceof Error ? error.message : error)) })
    return () => { live = false }
  }, [token, revision])
  const active = conversations.find(item => item.id === selected)
  const model = useMemo(() => [...stream.events].reverse().find(event => event.kind === 'run_started')?.payload?.model, [stream.events])
  const pending = useMemo(() => {
    const decisions = new Set(stream.events.filter(event => event.kind === 'tool_decision' || event.kind === 'tool_finished').map(event => event.tool_call_id))
    return [...stream.events].reverse().find(event => event.kind === 'tool_proposed' && /-approval-\d+$/.test(event.tool_call_id ?? '') && !decisions.has(event.tool_call_id))
  }, [stream.events])
  const workflowTimeline = useMemo(() => stream.events.filter(event => event.kind === 'workflow').slice(-16), [stream.events])
  const runStatus = useMemo(() => {
    const latest = [...stream.events].reverse().find(event => ['run_started', 'answer_finished', 'run_failed'].includes(event.kind))
    return latest?.kind === 'run_started' ? '运行中' : latest?.kind === 'run_failed' ? '运行失败' : latest?.kind === 'answer_finished' ? '已完成' : '未运行'
  }, [stream.events])
  const workspaceLabel = active?.remote_workspace_id ? `远程 · ${active.remote_username}@${active.remote_host}:${active.remote_port}${active.remote_root}` : active?.project_path ? `本机 · ${active.project_path}` : '未绑定代码工作区'
  const grouped = useMemo(() => {
    const result = new Map<string, Conversation[]>()
    for (const item of conversations) result.set(item.lake, [...(result.get(item.lake) ?? []), item])
    return result
  }, [conversations])

  return <div className="shell web-shell">
    <aside className="sidebar web-sidebar"><div className="brand"><strong>Lake</strong><span>Web 工作台 · 只读</span></div>
      <div className="nav-label"><span>会话 <em>{conversations.length}</em></span><button title="刷新会话" aria-label="刷新会话" onClick={() => setRevision(value => value + 1)}><RefreshCw size={14} /></button></div>
      {listError && <div className="web-error">{listError}</div>}
      <div className="sidebar-scroll">{[...grouped].map(([lake, items]) => <div className="tree-group" key={lake}><div className="folder-row"><Database size={14} /><span className="folder-name">{lake}</span><em>{items.length}</em></div><div className="tree-children">{items.map(item => <div className={'conversation-row ' + (selected === item.id ? 'selected' : '')} key={item.id}><ConversationOpen conversation={item} onOpen={() => setSelected(item.id)} /></div>)}</div></div>)}{conversations.length === 0 && !listError && <div className="empty-inline">暂无会话</div>}</div>
      <form className="web-token" onSubmit={event => { event.preventDefault(); setToken(tokenDraft.trim()) }}><label htmlFor="web-token">Web 令牌（远程访问）</label><input id="web-token" type="password" autoComplete="off" value={tokenDraft} onChange={event => setTokenDraft(event.target.value)} placeholder="本机无令牌时留空" /><button type="submit">连接</button></form>
    </aside>
    <main className="chat-panel web-chat"><header className="web-header"><div><h1>{active?.title ?? '选择会话'}</h1><p title={active ? `${active.lake} · ${workspaceLabel}` : undefined}>{active ? `湖 · ${active.lake} · ${workspaceLabel}` : '查看 Lake 会话记录'}</p></div><div className={'web-status ' + (stream.connected ? 'connected' : '')} aria-live="polite">{stream.connected ? <Wifi size={15} /> : <WifiOff size={15} />}<span>{stream.connected ? '实时连接' : '正在连接'}</span></div></header>
      <div className="web-context"><span><ModelStatus model={typeof model === 'string' ? model : undefined} online={typeof model === 'string'} /></span><span>运行状态：{pending ? '待审批' : runStatus}</span><span><ShieldCheck size={14} />Web 仅查看；审批请回到发起入口</span></div>
      {workflowTimeline.length > 0 && <details className="web-workflow-timeline"><summary>工作流时间线 · {workflowTimeline.length} 条事件</summary><ol>{workflowTimeline.map(event => <li key={event.sequence}><strong>{String(event.payload?.name ?? '工作流')}</strong><span>{String(event.payload?.step_name ?? '整体')} · {String(event.payload?.step_status || event.payload?.status || '运行中')}</span><small>{Number(event.payload?.completed ?? 0)}/{Number(event.payload?.total ?? 0)}</small></li>)}</ol></details>}
      <div className="messages web-messages" aria-live="polite">{stream.error && <div className="web-error">{stream.error}</div>}{selected && stream.messages.length === 0 && !stream.error && <div className="web-empty">会话暂无消息</div>}<ConversationMessages messages={stream.messages} uiScope={selected} />{pending && <ApprovalCard approval={{ kind: String(pending.payload?.tool_name ?? ''), path: String(pending.payload?.target ?? '等待原入口审批'), command: '具体操作内容仅在发起入口显示' }} />}</div>
    </main>
  </div>
}
