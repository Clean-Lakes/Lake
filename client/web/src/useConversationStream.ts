import { useEffect, useState } from 'react'
import { restoredMessages, type ChatMessage, type ConversationEvent, type ConversationTurn } from '../../desktop/frontend/src/timeline'
import { appendEventPage, type WireEvent } from './eventCursor'
import { settleActivities } from '../../desktop/frontend/src/activity'

export type StreamState = { messages: ChatMessage[]; events: ConversationEvent[]; connected: boolean; error: string }

function headers(token: string): HeadersInit { return token ? { Authorization: `Bearer ${token}` } : {} }

async function getJSON<T>(url: string, token: string): Promise<T> {
  const response = await fetch(url, { headers: headers(token), cache: 'no-store' })
  if (!response.ok) throw new Error(response.status === 401 ? '令牌无效或缺失' : `读取失败（${response.status}）`)
  return response.json() as Promise<T>
}

export function useConversationStream(id: string, token: string): StreamState {
  const [state, setState] = useState<StreamState>({ messages: [], events: [], connected: false, error: '' })
  useEffect(() => {
    if (!id) { setState({ messages: [], events: [], connected: false, error: '' }); return }
    let closed = false
    let socket: WebSocket | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let cursor = 0
    let events: ConversationEvent[] = []
    let turns: ConversationTurn[] = []
    let work = Promise.resolve()
    let delay = 500
    const base = `/api/v1/conversations/${encodeURIComponent(id)}`
    const sync = () => {
      work = work.then(async () => {
        if (closed) return
        let page: WireEvent[]
        do {
          page = await getJSON<WireEvent[]>(`${base}/events?after=${cursor}&limit=500`, token)
          const appended = appendEventPage(events, cursor, page, id)
          events = appended.events
          cursor = appended.cursor
        } while (page.length === 500 && !closed)
        turns = await getJSON<ConversationTurn[]>(`${base}/turns`, token)
        if (!closed) setState(previous => ({ ...previous, messages: restoredMessages(turns, events, { live: socket?.readyState === WebSocket.OPEN }), events: [...events], error: '' }))
      }).catch(error => { if (!closed) setState(previous => ({ ...previous, error: String(error instanceof Error ? error.message : error) })) })
    }
    const connect = () => {
      if (closed) return
      sync()
      void work.then(() => {
        if (closed) return
        const url = new URL(`${base}/stream?after=${cursor}`, location.href)
        url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
        socket = new WebSocket(url, token ? ['lake.v1', `lake.token.${token}`] : ['lake.v1'])
        socket.onopen = () => { delay = 500; setState(previous => ({ ...previous, connected: true, error: '' })); sync() }
        socket.onmessage = event => {
          try {
            const item = JSON.parse(event.data) as WireEvent
            if (item.version === 1 && item.session_id === id && item.sequence > cursor) sync()
          } catch { /* malformed frames are ignored; HTTP catch-up remains authoritative */ }
        }
        socket.onclose = () => {
          if (closed) return
          setState(previous => ({ ...previous, messages: settleActivities(previous.messages), connected: false }))
          timer = setTimeout(connect, delay)
          delay = Math.min(delay * 2, 10_000)
        }
        socket.onerror = () => socket?.close()
      })
    }
    setState({ messages: [], events: [], connected: false, error: '' })
    connect()
    return () => { closed = true; if (timer) clearTimeout(timer); socket?.close() }
  }, [id, token])
  return state
}
