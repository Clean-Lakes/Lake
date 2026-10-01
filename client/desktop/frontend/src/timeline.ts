import { executionFromEvent, upsertExecution, type ExecutionRecord } from './taskTerminal.ts'
import type { SpecialistCall } from './SpecialistCallCard'
import { parseWorkflowPlanning } from './workflowPlanning.ts'
import type { QuestionView, UserQuestion } from './userQuestions'
import { isWorkflowExecutionReport, parseVisualReport, type VisualReport } from './visualReport.ts'
import { applyActivityEvent, settleActivities, type ToolActivity } from './activity.ts'
import { parseUISnapshot, upsertUISurface, type UISnapshot } from './a2ui.ts'

export type ImageAttachment = { name?: string; mime_type: string; data: string }
export type MCPCall = { id: string; server: string; tool: string; status: 'running' | 'completed' | 'failed' }
export type ChatMessage = { id: string; role: 'user' | 'assistant' | 'error' | 'specialist' | 'activity' | 'mcp' | 'question' | 'execution' | 'report' | 'ui'; ui?: UISnapshot; activity?: ToolActivity; report?: VisualReport; detail?: boolean; execution?: ExecutionRecord; text: string; images?: ImageAttachment[]; stats?: string; specialist?: SpecialistCall; mcp?: MCPCall; question?: QuestionView }

export function reportRecoveryRunIDs(messages: ChatMessage[], errorID: string): string[] {
  const end = messages.findIndex(message => message.id === errorID)
  if (end < 0) return []
  const start = messages.slice(0, end).findLastIndex(message => message.role === 'user')
  const ids = new Set<string>()
  for (const message of messages.slice(Math.max(0, start), end)) {
    if (message.specialist?.kind === 'workflow' && message.specialist.run_id && /^[A-Za-z0-9_-]{1,128}$/.test(message.specialist.run_id)) ids.add(message.specialist.run_id)
    if (message.report && isWorkflowExecutionReport(message.report)) for (const source of message.report.sources ?? []) {
      const match = source.match(/^运行记录[：:]\s*([A-Za-z0-9_-]{1,128})$/)
      if (match) ids.add(match[1])
    }
  }
  return [...ids].slice(0, 8)
}
export type ConversationTurn = { id: string; prompt: string; answer: string; display: string; error: string; images?: ImageAttachment[]; specialists?: SpecialistCall[] }
export type ConversationEvent = { sequence: number; kind: string; actor?: string; tool_call_id?: string; legacy_turn_id?: string; payload: Record<string, unknown> }

export function splitStats(text: string) {
  const match = text.match(/\n\s*(耗时 [^\n]+)\s*$/)
  return match ? { body: text.slice(0, match.index).trim(), stats: match[1] } : { body: text.trim(), stats: '' }
}

function legacyMessages(turn: ConversationTurn): ChatMessage[] {
  const result = splitStats(turn.display)
  const items: ChatMessage[] = [{ id: `${turn.id}-user`, role: 'user', text: turn.prompt, images: turn.images }]
  for (const call of turn.specialists ?? []) items.push({ id: `${turn.id}:${call.id}`, role: 'specialist', text: '', specialist: call })
  if (result.body) items.push({ id: `${turn.id}-assistant`, role: 'assistant', text: result.body, stats: result.stats })
  if (turn.error) items.push({ id: `${turn.id}-error`, role: 'error', text: turn.error })
  return items
}

function preview(event: ConversationEvent, field: string): string {
  return typeof event.payload?.[field] === 'string' ? event.payload[field] as string : ''
}

function mcpDisplay(event: ConversationEvent): { server: string; tool: string } {
  const server = preview(event, 'mcp_server')
  const tool = preview(event, 'mcp_tool')
  if (server && tool) return { server, tool }
  const legacy = preview(event, 'tool_name').replace(/^mcp_/, '')
  const separator = legacy.indexOf('_')
  return separator > 0 ? { server: legacy.slice(0, separator), tool: legacy.slice(separator + 1) } : { server: '工具', tool: legacy || '调用' }
}

// The event sequence defines chronology. Legacy turns supply complete text and
// images because event payloads intentionally contain only bounded previews.
export function restoredMessages(turns: ConversationTurn[] | null | undefined, events: ConversationEvent[] | null = [], options: { live?: boolean } = {}): ChatMessage[] {
  turns ??= []
  events ??= []
  if (!events.length) return turns.flatMap(legacyMessages)
  const byID = new Map(turns.map(turn => [turn.id, turn]))
  const shown = new Set<string>()
  const shownCalls = new Set<string>()
  const mcpMessages = new Map<string, number>()
  const mcpApprovals = new Set<string>()
  const questions = new Map<string, number>()
  let messages: ChatMessage[] = []
  let activeTurn: ConversationTurn | undefined
  let hasReport = false
  let activeUserSequence = 0
  let runOpen = false
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    const turn = event.legacy_turn_id ? byID.get(event.legacy_turn_id) : activeTurn
    switch (event.kind) {
      case 'a2ui': {
        const snapshot = parseUISnapshot(preview(event, 'ui_json'))
        if (snapshot) messages = upsertUISurface(messages, snapshot, ui => ({ id: `ui-${ui.surfaceId}`, role: 'ui', text: '', ui }))
        break
      }
      case 'visual_report': {
        const report = parseVisualReport(preview(event, 'report_json'))
        if (report) {
          const execution = isWorkflowExecutionReport(report)
          const runID = execution ? report.sources?.map(source => source.match(/^运行记录[：:]\s*([A-Za-z0-9_-]{1,128})$/)?.[1]).find(Boolean) : undefined
          const start = messages.findLastIndex(message => message.role === 'user')
          if (runID && messages.slice(Math.max(0, start)).some(message => message.specialist?.kind === 'workflow' && message.specialist.run_id === runID)) break
          hasReport = hasReport || !execution
          messages.push({ id: `report-${preview(event, 'report_id') || event.sequence}`, role: 'report', text: '', report })
        }
        break
      }
      case 'workflow': {
        const runID = preview(event, 'run_id')
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(runID)) break
        const saved = turn?.specialists?.find(call => call.kind === 'workflow' && call.run_id === runID)
        const id = `${turn?.id || activeUserSequence}:${saved?.id || `workflow-${runID}`}`
        const index = messages.findIndex(message => message.id === id)
        const previous = index >= 0 ? messages[index].specialist : undefined
        const status = preview(event, 'status')
        const call: SpecialistCall = saved ?? { id: `workflow-${runID}`, kind: 'workflow', run_id: runID, task: preview(event, 'name') || '工作流', stage: status === 'completed' ? 'completed' : ['failed', 'interrupted', 'cancelled'].includes(status) ? 'failed' : 'working', completed: Number(event.payload.completed) || 0, total: Number(event.payload.total) || 0, steps: previous?.steps ?? [], planning: parseWorkflowPlanning(event.payload.planning_json) ?? previous?.planning }
        const message: ChatMessage = { id, role: 'specialist', text: '', specialist: call }
        if (index < 0) messages.push(message)
        else messages[index] = message
        if (saved) shownCalls.add(id)
        break
      }
 case "terminal_proposed": messages.push({id:`event-${event.sequence}`,role:"activity",text:`Lake 提议执行：${preview(event,"command")}`});break
 case "terminal_control": messages.push({id:`event-${event.sequence}`,role:"activity",text:preview(event,"status")==="resolved"?"终端操作已交回 Lake":preview(event,"owner")==="user"?"你接管了这一步":"终端交接已结束"});break
 case "execution_started":
 case "execution_finished": {const record=executionFromEvent(event,true);if(record)messages=upsertExecution(messages,record);break}
      case 'question_asked': {
        const id = preview(event, 'question_id')
        try {
          const items = JSON.parse(preview(event, 'questions_json')) as UserQuestion[]
          if (!id || !Array.isArray(items)) break
          questions.set(id, messages.length)
          messages.push({ id: `question-${id}`, role: 'question', text: '', question: { id, questions: items, status: 'interrupted' } })
        } catch { /* A malformed historical event cannot be submitted. */ }
        break
      }
      case 'question_answered': {
        const index = questions.get(preview(event, 'question_id'))
        if (index === undefined || !messages[index].question) break
        try {
          const answers = JSON.parse(preview(event, 'answers_json')) as Record<string, string>
          messages[index] = { ...messages[index], question: { ...messages[index].question!, status: 'answered', answers } }
        } catch { /* Keep the historical question inactive. */ }
        break
      }
      case 'user': {
        messages = settleActivities(messages)
        hasReport = false
        activeUserSequence = event.sequence
        activeTurn = turn
        if (turn) {
          shown.add(turn.id)
          messages.push({ id: `${turn.id}-user`, role: 'user', text: turn.prompt, images: turn.images })
        } else {
          messages.push({ id: `event-${event.sequence}`, role: 'user', text: preview(event, 'preview') })
        }
        break
      }
      case 'tool_proposed': {
        const name = preview(event, 'tool_name')
        if (name === 'lake_ask_user') break
        if (name.startsWith('mcp_')) {
          const display = mcpDisplay(event)
          const callID = event.tool_call_id || `event-${event.sequence}`
          mcpMessages.set(callID, messages.length)
          messages.push({ id: `event-${event.sequence}`, role: 'mcp', text: '', mcp: { id: callID, server: display.server, tool: display.tool, status: 'running' } })
          break
        }
        if (name === 'mcp') {
          if (event.tool_call_id) mcpApprovals.add(event.tool_call_id)
          break
        }
        const call = turn?.specialists?.find(item => item.id === event.tool_call_id)
        const callKey = call ? `${turn!.id}:${call.id}` : ''
        if (call && !shownCalls.has(callKey)) {
          shownCalls.add(callKey)
          messages.push({ id: `${turn!.id}:${call.id}`, role: 'specialist', text: '', specialist: call })
        } else if (!call) {
          messages = applyActivityEvent(messages, event, String(activeUserSequence))
        }
        break
      }
      case 'tool_finished': {
        const index = mcpMessages.get(event.tool_call_id || '')
        if (index !== undefined && messages[index].mcp) {
          const status = preview(event, 'status')
          messages[index] = { ...messages[index], mcp: { ...messages[index].mcp!, status: status === 'completed' ? 'completed' : 'failed' } }
        }
        messages = applyActivityEvent(messages, event, String(activeUserSequence))
        break
      }
      case 'tool_decision': {
        if (event.tool_call_id && mcpApprovals.has(event.tool_call_id)) break
        const outcome = preview(event, 'outcome')
        messages.push({ id: `event-${event.sequence}`, role: 'activity', text: outcome === 'approved' ? '操作已批准' : outcome === 'denied' ? '操作已拒绝' : '操作已中断' })
        break
      }
      case 'summary_created':
        messages = applyActivityEvent(messages, event, String(activeUserSequence))
        break
      case 'assistant_progress':
        if (preview(event, 'preview')) messages.push({ id: `event-${event.sequence}`, role: 'assistant', text: preview(event, 'preview') })
        break
      case 'assistant': {
        if (turn) {
          const result = splitStats(turn.display)
          if (result.body) messages.push({ id: `${turn.id}-assistant`, role: 'assistant', text: result.body, stats: result.stats, detail: hasReport && result.body.length > 600 })
          if (turn.error) messages.push({ id: `${turn.id}-error`, role: 'error', text: turn.error })
          shown.add(turn.id)
        } else if (preview(event, 'preview')) {
          messages.push({ id: `event-${event.sequence}`, role: 'assistant', text: preview(event, 'preview') })
        }
        break
      }
      case 'run_failed':
        runOpen = false
        messages = settleActivities(messages, String(activeUserSequence))
        if (!turn) messages.push({ id: `event-${event.sequence}`, role: 'error', text: preview(event, 'reason') || '运行失败' })
        break
      case 'run_started': runOpen = true; break
      case 'answer_finished':
        runOpen = false
        messages = settleActivities(messages, String(activeUserSequence))
        break
    }
  }
  for (const turn of turns) if (!shown.has(turn.id)) messages.push(...legacyMessages(turn))
  return options.live && runOpen ? messages : settleActivities(messages)
}
