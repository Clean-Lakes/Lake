import assert from 'node:assert/strict'
import test from 'node:test'
import { defaultReportUI, validateReportUI } from './reportUI.ts'
import { reportCatalog } from './reportCatalog.ts'
import { parseVisualReport } from './visualReport.ts'

const report = { title: '检查结果', summary: '8个待确认', tone: 'warning', metrics: [{ label: '待确认', value: '8', tone: 'unknown' }], findings: [{ title: '缺少健康检查', detail: '还需核对', tone: 'warning' }], table: { title: '清单', columns: ['名称'], rows: [{ cells: ['mysql'], tone: 'unknown' }] } }

test('default layouts are valid json-render specs and retain every fact', () => {
  const ui = defaultReportUI(report)
  assert.equal(validateReportUI(ui, report), true)
  assert.equal(reportCatalog.validate(ui).success, true)
  assert.deepEqual(ui.elements.views.props.labels, ['结果概览', '详细清单'])
  const single = { ...report, metrics: undefined, table: undefined }
  assert.equal(validateReportUI(defaultReportUI(single), single), true)
  const metricsOnly = { ...report, findings: undefined, table: undefined }
  assert.equal(reportCatalog.validate(defaultReportUI(metricsOnly)).success, true)
})

test('custom layouts support grouping, tabs and accordion without executing code', () => {
  const ui = { root: 'tabs', elements: {
    tabs: { type: 'Tabs', props: { labels: ['概览', '清单'] }, children: ['summary', 'details'] },
    summary: { type: 'Card', props: { title: '健康覆盖' }, children: ['metric', 'finding'] },
    metric: { type: 'Metric', props: { index: 0 } }, finding: { type: 'Finding', props: { index: 0 } },
    details: { type: 'Accordion', props: { title: '展开完整清单' }, children: ['table'] },
    table: { type: 'Table', props: {} },
  } }
  assert.equal(validateReportUI(ui, report), true)
  assert.deepEqual(parseVisualReport({ ...report, ui }).ui, ui)
  for (const mutation of [
    r => { r.elements.metric.type = 'HTML' },
    r => { r.elements.metric.props = { index: 99 } },
    r => { r.elements.metric.on = { press: { action: 'runCommand' } } },
    r => { r.elements.summary.children = ['summary'] },
    r => { r.elements.summary.children = ['metric', 'metric'] },
    r => { r.elements.tabs.props.labels = ['一页'] },
    r => { delete r.elements.finding; r.elements.summary.children = ['metric'] },
  ]) {
    const invalid = structuredClone(ui); mutation(invalid)
    assert.equal(validateReportUI(invalid, report), false)
    const fallback = parseVisualReport({ ...report, ui: invalid })
    assert.equal(fallback.ui, undefined)
    assert.equal(fallback.findings[0].title, '缺少健康检查')
  }
})
