import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

const DEFAULT_WIDTH = 220
const MIN_WIDTH = 180
const MAX_WIDTH = 480
const MAIN_MIN_WIDTH = 360
const STORAGE_KEY = 'lake.sidebar-width'

function savedWidth(): number {
  try {
    const value = Number(localStorage.getItem(STORAGE_KEY))
    if (Number.isFinite(value) && value >= MIN_WIDTH && value <= MAX_WIDTH) return Math.round(value)
  } catch { /* Resizing still works when local storage is unavailable. */ }
  return DEFAULT_WIDTH
}

function persistWidth(width: number) {
  try { localStorage.setItem(STORAGE_KEY, String(width)) } catch { /* Keep the current session's width. */ }
}

type Drag = { pointerID: number; startX: number; startWidth: number; preferredWidth: number }

export function ResizableSidebar({ children }: { children: ReactNode }) {
  const sidebar = useRef<HTMLElement>(null)
  const handle = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)
  const [preferredWidth, setPreferredWidth] = useState(savedWidth)
  const preferred = useRef(preferredWidth)
  const [availableWidth, setAvailableWidth] = useState(window.innerWidth)
  const [resizing, setResizing] = useState(false)
  const maxWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.floor(availableWidth - MAIN_MIN_WIDTH)))
  const bounded = (value: number) => Math.round(Math.min(maxWidth, Math.max(MIN_WIDTH, value)))
  const width = bounded(preferredWidth)

  const changeWidth = (value: number) => {
    preferred.current = value
    setPreferredWidth(value)
  }
  const endDrag = (commit = true) => {
    const active = drag.current
    if (!active) return
    drag.current = null
    setResizing(false)
    if (handle.current?.hasPointerCapture(active.pointerID)) handle.current.releasePointerCapture(active.pointerID)
    if (commit) persistWidth(preferred.current)
    else changeWidth(active.preferredWidth)
  }

  useLayoutEffect(() => {
    const container = sidebar.current?.parentElement
    if (!container) return
    const update = () => setAvailableWidth(container.clientWidth)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!resizing) return
    document.body.classList.add('lake-sidebar-resizing')
    const stop = () => endDrag()
    window.addEventListener('blur', stop)
    return () => { document.body.classList.remove('lake-sidebar-resizing'); window.removeEventListener('blur', stop) }
  }, [resizing])

  return <aside id="lake-sidebar" className="sidebar" style={{ width }} ref={sidebar}>
    {children}
    <div ref={handle} className={`sidebar-resize-handle${resizing ? ' resizing' : ''}`} role="separator" tabIndex={0}
      aria-label="调整侧栏宽度" aria-orientation="vertical" aria-controls="lake-sidebar"
      aria-valuemin={MIN_WIDTH} aria-valuemax={maxWidth} aria-valuenow={width} aria-valuetext={`侧栏宽度 ${width} 像素`}
      title="拖动调节侧栏宽度，双击恢复默认；方向键微调"
      onPointerDown={event => {
        if (event.button !== 0 || !event.isPrimary || drag.current) return
        event.preventDefault()
        event.currentTarget.focus({ preventScroll: true })
        event.currentTarget.setPointerCapture(event.pointerId)
        drag.current = { pointerID: event.pointerId, startX: event.clientX, startWidth: width, preferredWidth: preferred.current }
        setResizing(true)
      }}
      onPointerMove={event => {
        if (drag.current?.pointerID === event.pointerId) changeWidth(bounded(drag.current.startWidth + event.clientX - drag.current.startX))
      }}
      onPointerUp={event => { if (drag.current?.pointerID === event.pointerId) endDrag() }}
      onPointerCancel={event => { if (drag.current?.pointerID === event.pointerId) endDrag() }}
      onLostPointerCapture={event => { if (drag.current?.pointerID === event.pointerId) endDrag() }}
      onDoubleClick={() => { endDrag(false); changeWidth(DEFAULT_WIDTH); persistWidth(DEFAULT_WIDTH) }}
      onKeyDown={event => {
        if (event.key === 'Escape' && drag.current) { event.preventDefault(); endDrag(false); return }
        if (drag.current) return
        const step = event.shiftKey ? 50 : 10
        const value = event.key === 'ArrowLeft' ? width - step : event.key === 'ArrowRight' ? width + step : event.key === 'Home' ? MIN_WIDTH : event.key === 'End' ? maxWidth : null
        if (value === null) return
        event.preventDefault()
        const next = bounded(value)
        changeWidth(next); persistWidth(next)
      }}
    />
  </aside>
}
