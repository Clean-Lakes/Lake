import { useEffect, useState } from 'react'
import type { ExecutionRecord, TerminalStatus } from './taskTerminal'
import { ExecutionCard } from './shared/ExecutionCard'

export function TaskTerminalPanel({ conversationID, records, onRun, onQuote, blocked }: { conversationID: string; records: ExecutionRecord[]; onRun: (command: string) => Promise<void>; onQuote: (record: ExecutionRecord) => void; blocked: boolean }) {
  const [status, setStatus] = useState<TerminalStatus | null>(null)
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [output, setOutput] = useState('')
  useEffect(() => {
    setOutput('')
    const off = window.runtime?.EventsOn('lake:event', (event: { type: string; conversation_id?: string; text?: string; exit_code?: number }) => {
      if (event.conversation_id !== conversationID) return
      if (event.type === 'terminal_data') setOutput(previous => (previous + (event.text ?? '')).slice(-100000))
      if (event.type === 'terminal_exit') { setStatus(null); setOutput(previous => previous + `\n终端已退出（${event.exit_code ?? ''}）\n`) }
    })
    return () => off?.()
  }, [conversationID])
  useEffect(() => {
    let current = true
    window.go?.main?.App?.TaskTerminalStatus(conversationID).then(raw => { if (current) setStatus(JSON.parse(raw)) }).catch(cause => { if (current) setError(String(cause)) })
    return () => { current = false }
  }, [conversationID, records.at(-1)?.sequence, records.at(-1)?.status])
  async function run() {
    if (pending || !draft.trim() || blocked) return
    setPending(true); setError('')
    try { await onRun(draft); setDraft(''); const raw = await window.go?.main?.App?.TaskTerminalStatus(conversationID); if (raw) setStatus(JSON.parse(raw)) } catch (cause) { setError(String(cause)) }
    finally { setPending(false) }
  }
  return <div className="workbench-terminal task-terminal-panel"><div className="workbench-terminal-context"><strong>工作终端</strong><span>{status ? `${status.user ?? ''} · ${status.target ?? status.directory}` : '发送第一条命令时打开终端'}</span><span>Shell 状态持续保留，输出实时显示。</span>{status && <><button disabled={pending} onClick={() => void onRun('\u0003')}>中断</button><button disabled={pending} onClick={async () => { try { await window.go?.main?.App?.CloseTaskTerminal(conversationID); setStatus(null) } catch (cause) { setError(String(cause)) } }}>关闭终端</button></>}</div>{error && <div className="workbench-error">{error}</div>}<div className="workbench-terminal-history" role="log">{records.map(record => <ExecutionCard key={record.id} record={record} onQuote={onQuote} onFill={setDraft} />)}{output && <pre>{output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')}</pre>}</div><form onSubmit={event => { event.preventDefault(); void run() }}><input aria-label="任务终端命令" value={draft} onChange={event => setDraft(event.target.value)} disabled={pending || blocked} placeholder="输入命令或回答终端提示" /><button disabled={pending || blocked || !draft.trim()}>发送</button></form></div>
}
