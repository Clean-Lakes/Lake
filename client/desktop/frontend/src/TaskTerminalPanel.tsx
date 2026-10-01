import { useEffect, useState } from 'react'
import type { ExecutionRecord, TerminalStatus } from './taskTerminal'
import { ExecutionCard } from './shared/ExecutionCard'

export function TaskTerminalPanel({ conversationID, records, onRun, onQuote, blocked }: { conversationID: string; records: ExecutionRecord[]; onRun: (command: string) => Promise<void>; onQuote: (record: ExecutionRecord) => void; blocked: boolean }) {
  const [status, setStatus] = useState<TerminalStatus | null>(null)
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let current = true
    window.go?.main?.App?.TaskTerminalStatus(conversationID).then(raw => { if (current) setStatus(JSON.parse(raw)) }).catch(cause => { if (current) setError(String(cause)) })
    return () => { current = false }
  }, [conversationID, records.at(-1)?.sequence, records.at(-1)?.status])
  async function run() {
    if (pending || !draft.trim() || blocked) return
    setPending(true); setError('')
    try { await onRun(draft); setDraft('') } catch (cause) { setError(String(cause)) }
    finally { setPending(false) }
  }
  return <div className="workbench-terminal task-terminal-panel"><div className="workbench-terminal-context"><strong>任务工作终端</strong><span>{status ? `${status.user} · ${status.target} · ${status.directory}` : '执行第一条命令时建立工作终端'}</span><span>收起面板和切换模型后，Shell 状态继续保留；逐条执行，不支持交互式 TTY。</span>{status && <button disabled={pending || blocked || status.running} onClick={async () => { try { await window.go?.main?.App?.CloseTaskTerminal(conversationID); setStatus(null) } catch (cause) { setError(String(cause)) } }}>关闭工作终端</button>}</div>{error && <div className="workbench-error">{error}</div>}<div className="workbench-terminal-history" role="log">{records.map(record => <ExecutionCard key={record.id} record={record} onQuote={onQuote} onFill={setDraft} />)}</div><form onSubmit={event => { event.preventDefault(); void run() }}><input aria-label="任务终端命令" value={draft} onChange={event => setDraft(event.target.value)} disabled={pending || blocked} placeholder={blocked ? '先选择“这一步我来”接管' : '输入单行命令'} /><button disabled={pending || blocked || !draft.trim()}>执行</button></form></div>
}
