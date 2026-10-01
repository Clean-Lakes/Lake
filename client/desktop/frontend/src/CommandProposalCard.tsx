import { Hand, LoaderCircle, Play, SquareTerminal } from 'lucide-react'
import type { CommandProposal } from './taskTerminal'

export function CommandProposalCard({ proposal, canReturn, onRun, onTake, onReturn, onDecline }: { proposal: CommandProposal; canReturn: boolean; onRun: () => void; onTake: () => void; onReturn: () => void; onDecline: () => void }) {
  return <section className="command-proposal" aria-label="终端命令与控制权" aria-live="polite">
    <header><SquareTerminal size={15} /><strong>{proposal.owner === 'user' ? '你已接管 · Lake 等待结果' : proposal.running ? 'Lake 正在执行' : 'Lake 提议执行'}</strong>{proposal.running && <LoaderCircle className="spin" size={14} />}</header>
    <div className="execution-context">{proposal.kind === 'local' ? '本机' : '远程工作区'} · {proposal.target}<br />执行目录：{proposal.directory}</div><pre><code>{proposal.command}</code></pre>
    <div className="command-proposal-actions">{proposal.owner === 'agent' ? <><button type="button" disabled={proposal.running} onClick={onRun}><Play size={13} />允许执行</button><button type="button" disabled={proposal.running} onClick={onTake}><Hand size={13} />这一步我来</button><button type="button" disabled={proposal.running} onClick={onDecline}>拒绝</button></> : <><span>在下方命令框执行后，交回本次结果。</span><button type="button" disabled={!canReturn || proposal.running} onClick={onReturn}>交回 Lake</button></>}</div>
  </section>
}
