import { KeyRound } from 'lucide-react'

export type ApprovalView = { kind?: string; path?: string; command?: string }

const titles: Record<string, string> = {
  'code-edit': '请求修改代码文件', 'code-create': '请求创建代码文件',
  'code-patch': '请求修改多个代码文件', 'code-checkpoint': '请求保存代码检查点',
  'code-restore': '请求恢复代码检查点', 'code-run': '请求执行本地命令',
  mcp: '请求调用 MCP 工具', hook: '请求执行工作区 Hook',
  workflow: '请求保存或运行工作流',
}

export function ApprovalCard({ approval, onDecision }: { approval: ApprovalView; onDecision?: (allow: boolean) => void }) {
  return <div className="approval-card"><div className="approval-title"><KeyRound size={17} />{titles[approval.kind ?? ''] ?? '请求执行 SSH 命令'}</div><p>{approval.path}</p><pre>{approval.command}</pre>{onDecision ? <div className="approval-actions"><button onClick={() => onDecision(false)}>拒绝</button><button className="primary" onClick={() => onDecision(true)}>本次允许</button></div> : <p>请在发起操作的入口处理审批</p>}</div>
}
