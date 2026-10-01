import type { ConversationEvent, ChatMessage } from './timeline.ts'

export type ExecutionRecord = { id: string; sequence: number; scope_id: string; target: string; session_id: string; working_directory: string; next_directory?: string; user: string; command: string; stdout: string; stderr: string; exit_code: number; status: 'running' | 'completed' | 'failed' | 'unknown'; error: string; duration_ms: number; truncated: boolean; actor: string }
export type CommandProposal = { id: string; conversationID: string; afterSequence: number; directory: string; command: string; target: string; kind: 'local' | 'remote'; owner: 'agent' | 'user'; running: boolean }
export type TerminalStatus = { id: string; scope_id: string; root: string; directory: string; user: string; target: string; kind: string; running: boolean }

export function executionFromEvent(event: ConversationEvent, historical = false): ExecutionRecord | null {
  if (!['execution_started', 'execution_finished'].includes(event.kind)) return null
  const p = event.payload
  if (typeof p.id !== 'string' || typeof p.command !== 'string') return null
  const text = (key: string) => typeof p[key] === 'string' ? p[key] as string : ''
  const status = historical && event.kind === 'execution_started' ? 'unknown' : text('status')
  return { id: text('id'), sequence: event.sequence, scope_id: text('scope_id'), target: text('target'), session_id: text('session_id'), working_directory: text('working_directory'), next_directory: text('next_directory'), user: text('user'), command: text('command'), stdout: text('stdout'), stderr: text('stderr'), exit_code: typeof p.exit_code === 'number' ? p.exit_code : -1, status: ['running', 'completed', 'failed', 'unknown'].includes(status) ? status as ExecutionRecord['status'] : 'unknown', error: text('error'), duration_ms: typeof p.duration_ms === 'number' ? p.duration_ms : 0, truncated: p.truncated === true, actor: event.actor || 'user' }
}

export function upsertExecution(messages: ChatMessage[], record: ExecutionRecord): ChatMessage[] {
  const index = messages.findIndex(item => item.execution?.id === record.id)
  const message: ChatMessage = { id: `execution-${record.id}`, role: 'execution', text: '', execution: record }
  if (index < 0) return [...messages, message]
  if ((messages[index].execution?.sequence || 0) > record.sequence) return messages
  return messages.map((item, at) => at === index ? message : item)
}
export function executionReferenceLabel(records: ExecutionRecord[]): string {
  return records.map(item => `[引用执行 #E${item.sequence}]`).join('\n')
}
