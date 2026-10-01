import { Component, createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { A2uiSurface, createComponentImplementation, useSignalValue, type ReactComponentImplementation } from '@a2ui/react/v0_9'
import { Catalog, MessageProcessor, ActionSchema, childList, dynamicString, dynamicValue, dynamicNumber, type SurfaceModel } from '@a2ui/web_core/v0_9'
import { z } from 'zod-a2ui'
import { Activity, Copy, RefreshCw } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { UI_CATALOG, type UIAction, type UISnapshot } from '../a2ui'
import './A2UISurface.css'

const Enabled = createContext(false)
const CompactResult = createContext(false)
const CommandFill = createContext<((command: string) => void) | undefined>(undefined)

function CodeView({ text, label = '代码', language = '' }: { text: string; label?: string; language?: string }) {
 const [copied, setCopied] = useState(false), [error, setError] = useState('')
 const fill = useContext(CommandFill), command = text.trim()
 return <section className="lake-ui-code"><header><span>{label || language || '代码'}</span><div><button type="button" aria-label="复制代码" onClick={async () => { try { await navigator.clipboard.writeText(text); setCopied(true); setError('') } catch { setError('复制未完成，请选择代码复制') } }}><Copy size={12} />{copied ? '已复制' : '复制'}</button>{fill && command && !command.includes('\n') && command.length <= 4000 && <button type="button" onClick={() => fill(command)}>填入命令框</button>}</div></header><pre><code>{text}</code></pre>{error && <small role="alert">{error}</small>}</section>
}

function SafeMarkdown({ text }: { text: string }) {
 return <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
  // HTML remains escaped text. Links and images expose their source without
  // opening pages, fetching remote media, or executing generated content.
  a: ({ children, href }) => <span className="lake-ui-link">{children}{href && <> ({href})</>}</span>,
  img: ({ alt, src }) => <span>{alt || '图片'}{src && <> ({src})</>}</span>,
  pre: ({ node }) => { const child = node?.children[0]; const text = child && 'children' in child ? child.children.map(item => 'value' in item ? item.value : '').join('') : ''; const classes = child && 'properties' in child ? child.properties.className : []; const language = Array.isArray(classes) ? String(classes[0] || '').replace(/^language-/, '') : ''; return <CodeView text={text} language={language} label={language || '代码'} /> },
  table: ({ children }) => <div className="lake-ui-markdown-table"><table>{children}</table></div>,
 }}>{text}</ReactMarkdown>
}

const Markdown = createComponentImplementation({ name: 'Markdown', schema: z.object({ text: dynamicString() }) }, ({ props }) => <div className="lake-ui-markdown"><SafeMarkdown text={props.text || ''} /></div>)
const Code = createComponentImplementation({ name: 'Code', schema: z.object({ text: dynamicString(), label: dynamicString().optional(), language: z.string().optional() }) }, ({ props }) => <CodeView text={props.text || ''} label={props.label} language={props.language} />)
const List = createComponentImplementation({ name: 'List', schema: z.object({ items: dynamicValue(), label: dynamicString().optional(), ordered: z.boolean().optional(), start: z.number().optional() }) }, ({ props }) => {
 const items = Array.isArray(props.items) ? props.items as string[] : [], Tag = props.ordered ? 'ol' : 'ul'
 return <section className="lake-ui-list">{props.label && <strong>{props.label}</strong>}<Tag start={props.ordered ? props.start ?? 1 : undefined}>{items.map((item, i) => <li key={i}><div className="lake-ui-markdown"><SafeMarkdown text={item} /></div></li>)}</Tag></section>
})
const Column = createComponentImplementation({ name: 'Column', schema: z.object({ children: childList() }) }, ({ props, buildChild }) => <div className="lake-ui-column">{(props.children as string[]).map(child => buildChild(child))}</div>)
const Row = createComponentImplementation({ name: 'Row', schema: z.object({ children: childList() }) }, ({ props, buildChild }) => <div className="lake-ui-row">{(props.children as string[]).map(child => buildChild(child))}</div>)
const Card = createComponentImplementation({ name: 'Card', schema: z.object({ title: dynamicString(), children: childList() }) }, ({ props, buildChild }) => <section className="lake-ui-card"><h3>{props.title}</h3>{(props.children as string[]).map(child => buildChild(child))}</section>)
const Text = createComponentImplementation({ name: 'Text', schema: z.object({ text: dynamicString(), variant: z.string().optional() }) }, ({ props }) => props.variant === 'heading' ? <h2>{props.text}</h2> : <p className="lake-ui-text">{props.text}</p>)
const Metric = createComponentImplementation({ name: 'Metric', schema: z.object({ label: dynamicString(), value: dynamicString() }) }, ({ props }) => <div className={`lake-ui-metric${/^[-+]?\d[\d.,\s]*\s*(%|[a-zA-Z/]+)?$/.test(props.value ?? '') ? '' : ' lake-ui-metric-text'}`}><span>{props.label}</span><strong>{props.value}</strong></div>)
const Chart = createComponentImplementation({ name: 'Chart', schema: z.object({ label: dynamicString(), values: dynamicValue(), max: z.number().positive().optional(), unit: dynamicString().optional() }) }, ({ props }) => {
 const values = Array.isArray(props.values) ? props.values as { label: string; value: number }[] : []
 const max = props.max ?? Math.max(1, ...values.map(item => item.value))
 return <section className="lake-ui-chart" aria-label={props.label}><strong>{props.label}</strong>{values.map((item, i) => <div key={i}><span>{item.label}</span><div className="lake-ui-bar"><i style={{ width: `${Math.min(100, 100 * item.value / max)}%` }} /></div><b>{item.value}{props.unit || ''}</b></div>)}{!values.length && <p className="lake-ui-empty">尚无可绘制的数据</p>}</section>
})
const Button = createComponentImplementation({ name: 'Button', schema: z.object({ label: dynamicString(), action: ActionSchema }) }, ({ props, context }) => {
 const enabled = useContext(Enabled)
 const selectedHost = useSignalValue(context.dataContext.dataModel.getSignal<string>('/selectedHost'))
 const action = context.componentModel.properties.action as { event?: { name: string } }
 return <button className="lake-ui-button" type="button" disabled={!enabled || (action.event?.name === 'inspect_ports' && !selectedHost)} onClick={() => props.action()}>{props.label}</button>
})
const ChoicePicker = createComponentImplementation({ name: 'ChoicePicker', schema: z.object({ label: dynamicString(), value: dynamicString(), options: dynamicValue() }) }, ({ props }) => {
 const enabled = useContext(Enabled); const options = Array.isArray(props.options) ? props.options as { label: string; value: string }[] : []
 return <label className="lake-ui-input"><span>{props.label}</span><select aria-label={props.label} value={props.value ?? ''} disabled={!enabled || !options.length} onChange={event => props.setValue(event.target.value)}><option value="">请选择</option>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
})
const TextField = createComponentImplementation({ name: 'TextField', schema: z.object({ label: dynamicString(), value: dynamicString() }) }, ({ props }) => { const enabled = useContext(Enabled); return <label className="lake-ui-input"><span>{props.label}</span><input aria-label={props.label} value={props.value ?? ''} disabled={!enabled} onChange={event => props.setValue(event.target.value)} /></label> })
const Tabs = createComponentImplementation({ name: 'Tabs', schema: z.object({ labels: z.array(z.string()), children: childList(), active: dynamicNumber().optional() }) }, ({ props, buildChild }) => {
 const [local, setLocal] = useState(0); const children = props.children as string[]; const active = Math.min(props.active ?? local, children.length - 1)
 return <div className="lake-ui-tabs"><div role="tablist" aria-label="结果视图">{(props.labels as string[]).map((label, i) => <button key={i} role="tab" type="button" aria-selected={active === i} onClick={() => { setLocal(i); props.setActive?.(i) }} onKeyDown={event => { if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); const next = (active + (event.key === 'ArrowRight' ? 1 : -1) + children.length) % children.length; setLocal(next); props.setActive?.(next); (event.currentTarget.parentElement?.children[next] as HTMLElement)?.focus() } }}>{label}</button>)}</div>{children.map((child, i) => <div key={child} role="tabpanel" hidden={active !== i}>{buildChild(child)}</div>)}</div>
})
const headings: Record<string, string> = { protocol: '协议', address: '监听地址', port: '端口', process: '进程', pid: 'PID' }
const Table = createComponentImplementation({ name: 'Table', schema: z.object({ columns: z.array(z.string()), headers: z.array(z.string()).optional(), rows: dynamicValue(), label: dynamicString().optional(), action: ActionSchema.optional() }) }, ({ props, context }) => {
 const enabled = useContext(Enabled), compact = useContext(CompactResult); const [filter, setFilter] = useState(''); const rows = Array.isArray(props.rows) ? props.rows as Record<string, unknown>[] : []
 const display = rows.filter(row => Object.values(row).some(value => String(value ?? '').toLowerCase().includes(filter.toLowerCase())))
 const raw = context.componentModel.properties.action as { event?: { name: string } } | undefined
 const headerLabels = props.headers as string[] | undefined
 const content = <section className="lake-ui-table"><div className="lake-ui-table-head"><strong>{props.label || '详细清单'}</strong><small>{display.length}/{rows.length} 条</small></div><input type="search" value={filter} placeholder={raw?.event?.name === 'inspect_process' ? '搜索端口、地址或进程' : '搜索清单'} aria-label={`搜索${props.label || '清单'}`} onChange={event => setFilter(event.target.value)} /><div className="lake-ui-table-scroll"><table><thead><tr>{(props.columns as string[]).map((column, i) => <th key={column}>{headerLabels?.[i] ?? headings[column] ?? column}</th>)}{props.action && <th>操作</th>}</tr></thead><tbody>{display.map((row, index) => <tr key={index}>{(props.columns as string[]).map(column => <td key={column}>{row[column] === '' || row[column] == null ? '—' : String(row[column])}</td>)}{props.action && <td><button type="button" disabled={!enabled || (raw?.event?.name === 'inspect_process' && !row.pid)} onClick={() => {
  if (raw?.event?.name === 'inspect_process') {
   context.dataContext.set('/activeTab', 1)
   void context.dispatchAction({ event: { name: 'inspect_process', context: { resource: context.dataContext.dataModel.get('/resource'), pid: row.pid } } })
  } else props.action?.()
 }}>{raw?.event?.name === 'inspect_process' ? '查看进程与日志' : '继续处理'}</button></td>}</tr>)}</tbody></table>{!display.length && <div className="lake-ui-empty">{rows.length ? '没有匹配的记录' : '尚无记录；请查看上方状态。'}</div>}</div></section>
 return compact ? <details className="lake-ui-table-disclosure"><summary>{props.label || '详细清单'} · {rows.length} 条</summary>{content}</details> : content
})
const Log = createComponentImplementation({ name: 'Log', schema: z.object({ text: dynamicString(), label: dynamicString().optional() }) }, ({ props }) => <section className="lake-ui-log"><strong>{props.label || '详情'}</strong><pre>{props.text || '暂无数据'}</pre></section>)
const catalog = new Catalog(UI_CATALOG, 'v0.9.1', [Column, Row, Card, Text, Markdown, Code, List, Metric, Chart, Button, ChoicePicker, TextField, Tabs, Table, Log], [])

class SurfaceBoundary extends Component<{ children: ReactNode; revision: number }, { failed: boolean }> {
 state = { failed: false }
 static getDerivedStateFromError() { return { failed: true } }
 componentDidUpdate(previous: { revision: number }) { if (previous.revision !== this.props.revision && this.state.failed) this.setState({ failed: false }) }
 render() { return this.state.failed ? <p className="lake-ui-error">界面展示暂未完成，已保存的数据仍可查看。</p> : this.props.children }
}

export function A2UISurfaceCard({ snapshot, onAction, busy = false, reply = false, onCommandFill }: { snapshot: UISnapshot; onAction?: (action: UIAction) => Promise<void>; busy?: boolean; reply?: boolean; onCommandFill?: (command: string) => void }) {
 const processor = useRef<MessageProcessor<ReactComponentImplementation> | null>(null)
 const snapshotRef = useRef(snapshot); snapshotRef.current = snapshot
 const actionRef = useRef(onAction); actionRef.current = onAction
 const lock = useRef(false); const [sending, setSending] = useState(false); const [error, setError] = useState('')
 const [surface, setSurface] = useState<SurfaceModel<ReactComponentImplementation>>()
 const applied = useRef(0)
 const update = (p: MessageProcessor<ReactComponentImplementation>, next: UISnapshot) => {
  const messages: Parameters<typeof p.processMessages>[0] = [
   ...(!p.getSurface(next.surfaceId) ? [{ version: 'v0.9.1' as const, createSurface: { surfaceId: next.surfaceId, catalogId: UI_CATALOG } }] : []),
   ...(next.components.length ? [{ version: 'v0.9.1' as const, updateComponents: { surfaceId: next.surfaceId, components: next.components } }] : []),
   { version: 'v0.9.1', updateDataModel: { surfaceId: next.surfaceId, path: '/', value: next.data } },
  ]
  p.processMessages(messages); applied.current = next.revision; setSurface(p.getSurface(next.surfaceId))
 }
 useEffect(() => {
  const p = new MessageProcessor<ReactComponentImplementation>([catalog], async action => {
   if (lock.current || !actionRef.current) return
   lock.current = true; setSending(true); setError('')
   try { await actionRef.current({ surfaceId: action.surfaceId, sourceComponentId: action.sourceComponentId, name: action.name, context: action.context, revision: snapshotRef.current.revision }) }
   catch (cause) { setError(String(cause)) }
   finally { lock.current = false; setSending(false) }
  })
  processor.current = p
  try { update(p, snapshotRef.current) } catch { setError('界面格式暂不支持，已保存的数据仍保留。') }
  return () => { p.dispose(); processor.current = null; applied.current = 0 }
 }, [snapshot.surfaceId])
 useEffect(() => { const p = processor.current; if (p && applied.current !== snapshot.revision) { try { update(p, snapshot); setError('') } catch { setError('界面更新未完成，已有结果保留。') } } }, [snapshot])
 const enabled = Boolean(onAction) && !busy && !sending
 const interactive = snapshot.components.some(component => component.action)
 return <section id={`surface-${snapshot.surfaceId}`} className={`a2ui-surface-panel${reply ? ' lake-ui-reply' : ''}`} data-surface-id={snapshot.surfaceId}>{!reply && <div className="lake-ui-meta"><span><Activity size={14} />{interactive ? '交互结果' : '结果'}</span>{interactive && <span>{busy || sending ? <><RefreshCw size={12} className="spin" />正在处理</> : onAction ? '可继续操作' : '仅查看'}</span>}</div>}{error && <p className="lake-ui-error" role="alert">{error}</p>}<CommandFill.Provider value={onCommandFill}><Enabled.Provider value={enabled}><CompactResult.Provider value={!reply && !interactive}><SurfaceBoundary revision={snapshot.revision}>{surface && snapshot.components.length ? <A2uiSurface surface={surface} /> : <p>正在准备界面…</p>}</SurfaceBoundary></CompactResult.Provider></Enabled.Provider></CommandFill.Provider></section>
}
