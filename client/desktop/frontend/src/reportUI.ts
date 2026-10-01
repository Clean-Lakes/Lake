import type { VisualReport } from './visualReport.ts'

export type ReportUIType = 'Stack' | 'Grid' | 'Card' | 'Tabs' | 'Accordion' | 'Metric' | 'Chart' | 'Finding' | 'Table' | 'Flow'
export type ReportUIProps = { title?: string; columns?: number; index?: number; labels?: string[] }
export type ReportUIElement = { type: ReportUIType; props: ReportUIProps; children?: string[] }
export type ReportUI = { root: string; elements: Record<string, ReportUIElement> }

const idPattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown, limit: number) => typeof v === 'string' && !!v.trim() && [...v].length <= limit && !v.includes('\0')
const only = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key))

export function validateReportUI(value: unknown, report: VisualReport): value is ReportUI {
  if (!object(value) || !only(value, ['root', 'elements']) || typeof value.root !== 'string' || !idPattern.test(value.root) || !object(value.elements)) return false
  const elements = value.elements, ids = Object.keys(elements)
  if (!ids.length || ids.length > 64 || !elements[value.root]) return false
  const parents = new Map<string, number>(), metrics = new Set<number>(), charts = new Set<number>(), findings = new Set<number>()
  let table = false, flow = false
  for (const [id, e] of Object.entries(elements)) {
    if (!idPattern.test(id) || !object(e) || !only(e, ['type', 'props', 'children']) || !object(e.props) || (e.children !== undefined && (!Array.isArray(e.children) || e.children.length > 16))) return false
    const p = e.props, children = e.children as unknown[] | undefined
    let container = false
    switch (e.type) {
      case 'Stack': container = true; if (!only(p, [])) return false; break
      case 'Grid': container = true; if (!only(p, ['columns']) || !Number.isInteger(p.columns) || Number(p.columns) < 1 || Number(p.columns) > 4) return false; break
      case 'Card': case 'Accordion': container = true; if (!only(p, ['title']) || !text(p.title, 80)) return false; break
      case 'Tabs': container = true; if (!only(p, ['labels']) || !Array.isArray(p.labels) || p.labels.length < 2 || p.labels.length > 6 || p.labels.length !== children?.length || p.labels.some(label => !text(label, 40))) return false; break
      case 'Metric': case 'Chart': case 'Finding': {
        if (!only(p, ['index']) || !Number.isInteger(p.index) || Number(p.index) < 0) return false
        const index = Number(p.index), values = e.type === 'Metric' ? report.metrics : e.type === 'Chart' ? report.charts : report.findings
        if (index >= (values?.length ?? 0)) return false
        const covered = e.type === 'Metric' ? metrics : e.type === 'Chart' ? charts : findings
        covered.add(index)
        break
      }
      case 'Table': if (!only(p, []) || !report.table) return false; table = true; break
      case 'Flow': if (!only(p, []) || !report.flow) return false; flow = true; break
      default: return false
    }
    if ((container && !children?.length) || (!container && !!children?.length)) return false
    for (const child of children ?? []) {
      if (typeof child !== 'string' || !Object.hasOwn(elements, child)) return false
      parents.set(child, (parents.get(child) ?? 0) + 1)
      if (parents.get(child)! > 1) return false
    }
  }
  if (parents.has(value.root)) return false
  const seen = new Set<string>()
  const visit = (id: string, depth: number): boolean => {
    if (depth > 8 || seen.has(id)) return false
    seen.add(id)
    return ((elements[id] as ReportUIElement).children ?? []).every(child => visit(child, depth + 1))
  }
  return visit(value.root, 1) && seen.size === ids.length && metrics.size === (report.metrics?.length ?? 0) && charts.size === (report.charts?.length ?? 0) && findings.size === (report.findings?.length ?? 0) && (!report.table || table) && (!report.flow || flow)
}

// Legacy reports also use the renderer. Choose a concise default while keeping
// every fact available. AI-provided layouts may reorder and group these widgets.
export function defaultReportUI(report: VisualReport): ReportUI {
  const elements: ReportUI['elements'] = {}, root: string[] = [], panels: string[] = [], labels: string[] = []
  const node = (id: string, type: ReportUIType, props: ReportUIProps = {}, children: string[] = []) => { elements[id] = { type, props, children }; return id }
  if (report.metrics?.length) root.push(node('metrics', 'Grid', { columns: Math.min(4, report.metrics.length) }, report.metrics.map((_, index) => node(`metric-${index}`, 'Metric', { index }))))
  const overview: string[] = []
  if (report.charts?.length) overview.push(node('charts', 'Grid', { columns: Math.min(2, report.charts.length) }, report.charts.map((_, index) => node(`chart-${index}`, 'Chart', { index }))))
  if (report.findings?.length) overview.push(node('findings', 'Card', { title: '需要关注' }, report.findings.map((_, index) => node(`finding-${index}`, 'Finding', { index }))))
  if (overview.length) { panels.push(node('overview', 'Stack', {}, overview)); labels.push('结果概览') }
  if (report.table) { panels.push(node('table', 'Table')); labels.push('详细清单') }
  if (report.flow) { panels.push(node('flow', 'Flow')); labels.push('执行流程') }
  if (panels.length > 1) root.push(node('views', 'Tabs', { labels }, panels))
  else root.push(...panels)
  node('root', 'Stack', {}, root)
  return { root: 'root', elements }
}
