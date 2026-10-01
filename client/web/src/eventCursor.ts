import type { ConversationEvent } from '../../desktop/frontend/src/timeline'

export type WireEvent = ConversationEvent & { version: number; session_id: string }

// HTTP pages are authoritative. A duplicate can arrive after reconnect, but
// a gap must be retried rather than silently presenting a partial timeline.
export function appendEventPage(current: ConversationEvent[], cursor: number, page: WireEvent[], sessionID: string) {
  const next = [...current]
  let sequence = cursor
  for (const event of page) {
    if (event.version !== 1 || event.session_id !== sessionID) throw new Error('事件协议或会话不匹配')
    if (event.sequence <= sequence) continue
    if (event.sequence !== sequence + 1) throw new Error('会话事件序号不连续')
    next.push(event)
    sequence = event.sequence
  }
  return { events: next, cursor: sequence }
}
