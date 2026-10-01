import type { ChatMessage, ConversationEvent } from './timeline.ts'
import catalog from '../../../../cmd/lake/activity_tools.json' with { type: 'json' }

export type ActivityStatus = 'running' | 'completed' | 'failed' | 'unknown' | 'cancelled'
export type ActivityKind = 'read' | 'list' | 'search' | 'command' | 'edit' | 'create' | 'delete' | 'restore' | 'checkpoint' | 'browser' | 'query' | 'task' | 'workflow' | 'report' | 'context' | 'tool'
export type ToolActivity = { id: string; turnID: string; tool: string; kind: ActivityKind; action: string; status: ActivityStatus; detail: string; sequence: number; durationMS?: number; count?: number; errorCode?: string }

const kinds = new Set<ActivityKind>(['read', 'list', 'search', 'command', 'edit', 'create', 'delete', 'restore', 'checkpoint', 'browser', 'query', 'task', 'workflow', 'report', 'context', 'tool'])
export function toolAction(name: string): { kind: ActivityKind; action: string } {
  const definition = (catalog as Record<string, { kind: string; action: string }>)[name]
  return definition && kinds.has(definition.kind as ActivityKind) ? { kind: definition.kind as ActivityKind, action: definition.action } : { kind: 'tool', action: `调用 ${name}` }
}

export function activityLabel(activity: ToolActivity): string {
  if (activity.kind === 'context') return '上下文已自动压缩'
  if (activity.status === 'running') return activity.kind === 'command' ? '正在处理命令' : `正在${activity.action}`
  if (activity.status === 'completed') return `已${activity.action}`
  if (activity.status === 'failed' && ['invalid_ui', 'invalid_report'].includes(activity.errorCode ?? '')) return '界面格式待修正'
  if (activity.status === 'failed') return `${activity.action}失败`
  if (activity.status === 'cancelled') return `${activity.action}已取消`
  return `${activity.action} · 结果未知`
}

// Live bridge notifications and saved events share this reducer, including
// call identity and chronology. No output or execution is inferred from text.
export function applyActivityEvent(messages: ChatMessage[], event: ConversationEvent, turnID: string): ChatMessage[] {
  const text = (key: string) => typeof event.payload[key] === 'string' ? event.payload[key] as string : ''
  if (event.kind === 'summary_created') {
    const id = `${turnID}:summary:${event.sequence}`
    if (messages.some(message => message.id === id)) return messages
    const tokens = event.payload.token_estimate
    const activity: ToolActivity = { id, turnID, tool: '', kind: 'context', action: '压缩上下文', status: 'completed', detail: typeof tokens === 'number' && tokens > 0 ? `历史摘要约 ${tokens} Token` : '', sequence: event.sequence }
    return [...messages, { id, role: 'activity', text: '', activity }]
  }
  const id = `${turnID}:activity:${event.tool_call_id || event.sequence}`
  const index = messages.findIndex(message => message.id === id && message.activity)
  if (event.kind === 'tool_finished') {
    if (index < 0 || event.sequence <= messages[index].activity!.sequence) return messages
    const status = text('status')
    const errorCode = text('error_code')
    const updated: ToolActivity = { ...messages[index].activity!, status: ['completed', 'failed', 'unknown', 'cancelled'].includes(status) ? status as ActivityStatus : 'unknown', sequence: event.sequence, durationMS: typeof event.payload.duration_ms === 'number' ? event.payload.duration_ms : undefined, errorCode: ['invalid_ui', 'invalid_report', 'presentation_unavailable'].includes(errorCode) ? errorCode : undefined }
    return messages.map((message, position) => position === index ? { ...message, activity: updated } : message)
  }
  if (event.kind !== 'tool_proposed' || index >= 0) return messages
  const name = text('tool_name')
  // Questions, specialists and MCP already have dedicated live cards.
  if (!name.startsWith('lake_') || name === 'lake_ask_user' || name === 'lake_ssh_agent' || name === 'lake_code_agent' || name.startsWith('lake_specialist_')) return messages
  const fallback = toolAction(name)
  const kind = text('activity_kind') as ActivityKind
  const action = text('activity_action')
  const definition = kinds.has(kind) && action && action.length <= 80 ? { kind, action } : fallback
  const count = event.payload.activity_count
  const activity: ToolActivity = { id, turnID, tool: name, ...definition, status: 'running', detail: text('preview'), sequence: event.sequence, count: typeof count === 'number' && Number.isInteger(count) && count > 0 && count <= 8 ? count : 1 }
  return [...messages, { id, role: 'activity', text: '', activity }]
}

export function settleActivities(messages: ChatMessage[], turnID?: string): ChatMessage[] {
  return messages.map(message => message.activity?.status === 'running' && (!turnID || message.activity.turnID === turnID) ? { ...message, activity: { ...message.activity, status: 'unknown' } } : message)
}

export function groupedActivityLabel(activities: ToolActivity[]): string {
  if (activities.length === 1) return activityLabel(activities[0])
  if (isPresentationActivity(activities[0])) {
    const last = activities.at(-1)!
    if (last.status === 'completed') return `界面已展示 · ${activities.length - 1} 次调整`
    if (last.status === 'running') return '正在调整界面'
    return `${activityLabel(last)} · ${activities.length} 次尝试`
  }
  const parts: string[] = []
  const counts = new Map<string, number>()
  for (const item of activities) {
    const label = item.kind === 'search' ? '搜索' : item.kind === 'command' ? '运行' : item.action.replace(/文件$/, '').trim()
    const unit = item.kind === 'search' ? '次' : item.kind === 'command' ? '条命令' : '个文件'
    const key = `${label}\t${unit}`
    counts.set(key, (counts.get(key) ?? 0) + (item.count ?? 1))
  }
  for (const [key, count] of counts) { const [label, unit] = key.split('\t'); parts.push(`${label} ${count} ${unit}`) }
  return `已${parts.join('，')}`
}

const isPresentationActivity = (item: ToolActivity) => item.tool === 'lake_ui' || item.tool === 'lake_visual_report'

export const isPresentationFormatRejection = (item: ToolActivity) => isPresentationActivity(item) && item.status === 'failed' && ['invalid_ui', 'invalid_report'].includes(item.errorCode ?? '')

export function groupedActivityStatus(activities: ToolActivity[]): ActivityStatus {
  return isPresentationActivity(activities[0]) ? activities.at(-1)!.status : activities[0].status
}

export function canGroupPresentationActivities(previous: ToolActivity[], next: ToolActivity): boolean {
  if (!previous.length || previous.length >= 4 || !isPresentationActivity(next)) return false
  // Older records have no rejection category. They can be summarized after a
  // successful retry, but never inferred to be recovering while still running.
  const rejected = (item: ToolActivity) => item.status === 'failed' && (!item.errorCode || ['invalid_ui', 'invalid_report'].includes(item.errorCode))
  if (!previous.every(item => item.tool === next.tool && item.turnID === next.turnID && rejected(item))) return false
  if (next.status === 'completed') return true
  return previous.every(item => item.errorCode) && (next.status === 'running' || next.status === 'failed' && rejected(next) && Boolean(next.errorCode))
}

export function canGroupActivities(previous: ToolActivity[], next: ToolActivity): boolean {
  // File mutations remain individually inspectable; unrelated workflow or UI
  // writes never become "edited files" just because they share a kind.
  const groupable = (item: ToolActivity) => item.status === 'completed' && (item.kind === 'command' || item.kind === 'search' || /^lake_(remote_)?code_/.test(item.tool) && ['read', 'edit', 'create', 'delete'].includes(item.kind) && item.tool !== 'lake_code_diff')
  return previous.length < 24 && previous.every(groupable) && groupable(next) && previous[0].turnID === next.turnID
}
