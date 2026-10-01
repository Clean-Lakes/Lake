import { Clock3, CornerDownLeft, LoaderCircle, MessageSquare, SquareTerminal } from 'lucide-react'
import type { ExecutionRecord } from '../taskTerminal'

export function ExecutionCard({ record, onQuote, onFill }: { record: ExecutionRecord; onQuote?: (record: ExecutionRecord) => void; onFill?: (command: string) => void }) {
  const status = record.status === 'running' ? '执行中' : record.status === 'unknown' ? '结果未知' : `退出码 ${record.exit_code}`
  return <article className={`execution-card ${record.status}`} aria-label={`执行 #E${record.sequence}`}>
    <header><span><SquareTerminal size={14} />{record.actor === 'agent' ? 'Lake 执行' : '你执行'} · #E{record.sequence}</span><span>{record.status === 'running' && <LoaderCircle className="spin" size={12} />}{status}</span></header>
    <div className="execution-context">{record.user}@{record.target} · {record.working_directory}</div>
    <pre className="execution-command"><code>$ {record.command}</code></pre>
    {(record.stdout || record.stderr) && <details open><summary>执行输出{record.truncated ? ' · 已截断' : ''}</summary><pre>{record.stdout}{record.stderr && <span className="execution-stderr">{record.stderr}</span>}</pre></details>}
    {record.error && <p className="execution-error">{record.error}</p>}
    {record.status === 'unknown' && <p className="execution-error">先核对实际状态，再决定下一步操作。</p>}
    <footer><span><Clock3 size={12} />{(record.duration_ms / 1000).toFixed(1)} 秒</span><div>{onQuote && record.status !== 'running' && <button type="button" onClick={() => onQuote(record)}><MessageSquare size={13} />问这次执行</button>}{onFill && record.status !== 'running' && !record.command.includes('[redacted]') && <button type="button" onClick={() => onFill(record.command)}><CornerDownLeft size={13} />填入命令框</button>}</div></footer>
  </article>
}
