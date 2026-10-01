import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import type { RootContent, Nodes, Table as MarkdownTable } from 'mdast'
import { UI_CATALOG, type UISnapshot } from './a2ui.ts'

const parser = unified().use(remarkParse).use(remarkGfm)
const encoder = new TextEncoder()
const byteLength = (text: string) => encoder.encode(text).length
const binding = (path: string) => ({ path: `/${path}` })
type Component = Record<string, unknown>
type Unit = { root: string; components: Component[]; data: Record<string, unknown>; section: number; title?: string }

function hash(text: string): string {
 let value = 2166136261
 for (const char of text) value = Math.imul(value ^ char.codePointAt(0)!, 16777619)
 return (value >>> 0).toString(36)
}

// Split only at Unicode character boundaries. Every source character is kept.
export function replyTextChunks(text: string, limit = 8000): string[] {
 const parts: string[] = []; let part = '', size = 0
 for (const char of text) {
  const length = byteLength(char)
  if (size + length > limit) { parts.push(part); part = ''; size = 0 }
  part += char; size += length
 }
 if (part || !parts.length) parts.push(part)
 return parts
}

function inlineText(node: Nodes): string {
 if (node.type === 'link') return node.children.map(inlineText).join('') + ` (${node.url})`
 if (node.type === 'image') return `${node.alt || '图片'} (${node.url})`
 if (node.type === 'break') return '\n'
 if ('value' in node && typeof node.value === 'string') return node.value
 return 'children' in node ? node.children.map(inlineText).join('') : ''
}

function percentageChart(table: MarkdownTable, rows: Record<string, string>[], columns: string[]) {
 if (columns.length < 2 || rows.length < 2 || rows.length > 16) return null
 const names = rows.map(row => row[columns[0]])
 if (names.some(name => !name) || new Set(names).size !== names.length) return null
 for (let i = 1; i < columns.length; i++) {
  const values = rows.map(row => row[columns[i]].match(/^(\d+(?:\.\d+)?)\s*[%％]$/))
  if (values.every(value => value && Number(value[1]) <= 100)) return {
   label: inlineText(table.children[0].children[i]) || '百分比对比',
   values: values.map((value, index) => ({ label: names[index], value: Number(value![1]) })),
  }
 }
 return null
}

/** Automatic, action-free views of the persisted answer. No model request or
 * backend surface is created. The source transcript remains authoritative. */
export function automaticReplySurfaces(text: string, messageID: string): UISnapshot[] {
 if (!text.trim()) return []
 const tree = parser.parse(text)
 const units: Unit[] = []; let index = 0, section = 0; let title: string | undefined
 const id = () => `block-${index++}`
 const add = (root: string, components: Component[], data: Record<string, unknown>) => units.push({ root, components, data, section, title })
 const markdown = (source: string) => { for (const part of replyTextChunks(source)) { const root = id(); add(root, [{ id: root, component: 'Markdown', text: binding(root) }], { [root]: part }) } }
 const source = (node: RootContent | Nodes) => text.slice(node.position?.start.offset ?? 0, node.position?.end.offset ?? text.length)
 // Reference definitions and footnotes must stay with the referring text.
 if (tree.children.some(node => node.type === 'definition' || node.type === 'footnoteDefinition')) markdown(text)
 else for (const node of tree.children) {
  if (node.type === 'heading') { section++; title = inlineText(node); if (byteLength(title) > 1000) { title = undefined; markdown(source(node)) }; continue }
  if (node.type === 'code' || node.type === 'html') {
   if (node.type === 'code' && byteLength(node.meta || '') > 2000) { markdown(source(node)); continue }
   const value = node.value, language = node.type === 'html' ? 'html' : (node.lang || '').slice(0, 80)
   const parts = replyTextChunks(value)
   for (const [partIndex, part] of parts.entries()) {
    const root = id()
    add(root, [{ id: root, component: 'Code', text: binding(root), language, label: `${language || '代码'}${parts.length > 1 ? ` · ${partIndex + 1}/${parts.length}` : ''}${node.type === 'code' && node.meta ? ` · ${node.meta}` : ''}` }], { [root]: part })
   }
   continue
  }
  if (node.type === 'list') {
   if (node.children.some(item => item.checked != null) || (node.start ?? 1) < 1 || (node.start ?? 1) + node.children.length > 1000000) { markdown(source(node)); continue }
   const items = node.children.map(item => item.children.map(source).join('\n\n'))
   if (items.some(item => byteLength(item) > 8000)) { markdown(source(node)); continue }
   let batch: string[] = [], size = 0, offset = 0
   const flush = () => {
    if (!batch.length) return
    const root = id()
    add(root, [{ id: root, component: 'List', items: binding(root), ordered: Boolean(node.ordered), start: (node.start ?? 1) + offset }], { [root]: batch })
    offset += batch.length; batch = []; size = 0
   }
   for (const item of items) { if (batch.length >= 200 || size + byteLength(item) > 8000) flush(); batch.push(item); size += byteLength(item) }
   flush(); continue
  }
  if (node.type === 'table') {
   const headers = node.children[0].children.map(inlineText)
   const columns = headers.map((_, i) => `column-${i}`)
   const rows = node.children.slice(1).map(row => Object.fromEntries(columns.map((column, i) => [column, row.children[i] ? inlineText(row.children[i]) : ''])))
   if (!headers.length || headers.length > 12 || byteLength(JSON.stringify(headers)) > 2000 || rows.some(row => byteLength(JSON.stringify(row)) > 8000)) { markdown(source(node)); continue }
   const chart = byteLength(JSON.stringify(rows)) <= 8000 ? percentageChart(node, rows, columns) : null
   let batch: Record<string, string>[] = [], size = 0, chunk = 0
   const flush = () => {
    if (!batch.length && chunk) return
    const root = id(), table = chart ? id() : root, data: Record<string, unknown> = { [table]: batch }
    const components: Component[] = [{ id: table, component: 'Table', label: '详细清单', columns, headers, rows: binding(table) }]
    if (chart) {
     const graph = id(); data[graph] = chart.values
     components.unshift({ id: root, component: 'Tabs', labels: ['概览', '详细清单'], children: [graph, table] })
     components.push({ id: graph, component: 'Chart', label: chart.label, unit: '%', max: 100, values: binding(graph) })
    }
    add(root, components, data); batch = []; size = 0; chunk++
   }
   for (const row of rows) { if (batch.length >= 200 || size + byteLength(JSON.stringify(row)) > 8000) flush(); batch.push(row); size += byteLength(JSON.stringify(row)) }
   if (batch.length || !rows.length) flush()
   continue
  }
  if (node.type === 'paragraph' && node.children.every(child => child.type === 'text')) {
   const metric = inlineText(node).match(/^([^\n:：]{1,60})[:：]\s*([+-]?\d+(?:\.\d+)?\s*(?:[%％]|ms|毫秒|秒|MB|GB|GiB|MiB|个|项|台|次|条|核))$/i)
   if (metric) { const root = id(); add(root, [{ id: root, component: 'Metric', label: metric[1], value: metric[2] }], {}); continue }
  }
  markdown(source(node))
 }
 // A heading-only answer is still a visible reply.
 if (!units.length) { title = undefined; markdown(text) }
 const snapshots: UISnapshot[] = []
 let components: Component[] = [{ id: 'root', component: 'Column', children: [] }], data: Record<string, unknown> = {}, sections = new Map<number, string>()
 const flush = () => {
  if (components.length === 1) return
  snapshots.push({ surfaceId: `reply-${hash(messageID)}-${snapshots.length}`, catalogId: UI_CATALOG, revision: parseInt(hash(text), 36) + 1, components, data })
  components = [{ id: 'root', component: 'Column', children: [] }]; data = {}; sections = new Map()
 }
 for (const unit of units) {
  const append = (target: Component[], values: Record<string, unknown>, groups: Map<number, string>) => {
   const copy: Component[] = target.map(component => ({ ...component, ...(Array.isArray(component.children) ? { children: [...component.children] } : {}) }))
   let parent = copy[0]
   if (unit.title) {
    let group = groups.get(unit.section)
    if (!group) { group = `section-${unit.section}`; groups.set(unit.section, group); copy.push({ id: group, component: 'Card', title: unit.title, children: [] }); (copy[0].children as string[]).push(group) }
    parent = copy.find(component => component.id === group)!
   }
   ;(parent.children as string[]).push(unit.root)
   return { components: [...copy, ...unit.components], data: { ...values, ...unit.data }, groups }
  }
  let next = append(components, data, new Map(sections))
  if (next.components.length > 60 || byteLength(JSON.stringify(next)) > 36000) { flush(); next = append(components, data, new Map(sections)) }
  components = next.components; data = next.data; sections = next.groups
 }
 flush(); return snapshots
}
