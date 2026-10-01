import assert from 'node:assert/strict'
import test from 'node:test'
import { isReportFormattingError, isWorkflowExecutionReport, parseVisualReport, flowLayout } from './visualReport.ts'
import { reportRecoveryRunIDs, restoredMessages } from './timeline.ts'

const report = { title: '检查结果', summary: '有一项待确认', tone: 'warning', charts: [{ title: '健康覆盖', kind: 'distribution', segments: [{ label: '已确认', value: 6, tone: 'good' }, { label: '无健康检查', value: 8, tone: 'unknown' }] }], table: { title: '清单', columns: ['名称', '状态'], rows: [{ cells: ['mysql', '尚未确认健康'], tone: 'unknown' }] } }
const execution = { title: '端口巡检 · 执行结果', summary: '工作流已执行完成', tone: 'info', scope: '本次运行快照 · fixture-host', metrics: [{ label: '执行步骤', value: '1', tone: 'info' }, { label: '已完成', value: '1', tone: 'info' }, { label: '需核对', value: '0', tone: 'info' }], flow: { nodes: [{ id: 'step', label: '端口查询', status: 'completed' }] }, sources: ['运行记录：run-1'] }

test('visual reports restore in their turn and long prose is folded', () => {
  const turns = [{ id: 'one', prompt: '检查状态', display: '详细说明'.repeat(200), error: '' }, { id: 'two', prompt: '说明原因', display: '原因说明'.repeat(200), error: '' }]
  const messages = restoredMessages(turns, [
    { sequence: 1, kind: 'user', legacy_turn_id: 'one', payload: {} },
    { sequence: 2, kind: 'tool_proposed', payload: { tool_name: 'lake_visual_report' } },
    { sequence: 3, kind: 'visual_report', payload: { report_id: 'r', report_json: JSON.stringify(report) } },
    { sequence: 4, kind: 'assistant', legacy_turn_id: 'one', payload: {} },
    { sequence: 5, kind: 'user', legacy_turn_id: 'two', payload: {} },
    { sequence: 6, kind: 'assistant', legacy_turn_id: 'two', payload: {} },
  ])
  assert.deepEqual(messages.map(m => m.role), ['user', 'activity', 'report', 'assistant', 'user', 'assistant'])
  assert.equal(messages[1].activity.kind, 'report')
  assert.equal(messages[2].report.table.rows[0].tone, 'unknown')
  assert.equal(messages[3].detail, true)
  assert.equal(messages[5].detail, false)
})

test('invalid reports cannot break the conversation or show invalid charts', () => {
  assert.ok(parseVisualReport(report))
  assert.equal(parseVisualReport({ ...report, table: { ...report.table, rows: [{ cells: ['ragged'], tone: 'info' }] } }), null)
  assert.equal(parseVisualReport({ ...report, charts: [{ ...report.charts[0], segments: [{ label: 'missing', value: 0, tone: 'unknown' }] }] }), null)
  assert.equal(parseVisualReport({ ...report, charts: [{ ...report.charts[0], segments: [{ label: 'bad', value: -1, tone: 'good' }] }] }), null)
  assert.deepEqual(restoredMessages([], [{ sequence: 1, kind: 'visual_report', payload: { report_json: '{}' } }]), [])
})

test('flow graph preserves forks and joins and rejects cycles', () => {
  const nodes = ['a', 'b', 'c', 'd'].map(id => ({ id, label: id, status: 'completed' }))
  const edges = [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }, { from: 'b', to: 'd' }, { from: 'c', to: 'd' }]
  const layout = flowLayout({ nodes, edges })
  assert.equal(layout.positions.get('b').y, layout.positions.get('c').y)
  assert.ok(layout.positions.get('d').y > layout.positions.get('b').y)
  assert.equal(parseVisualReport({ ...report, flow: { nodes, edges: [...edges, { from: 'd', to: 'a' }] } }), null)
})

test('execution receipts do not hide actual prose and restored traces replace duplicate receipts', () => {
  assert.equal(isWorkflowExecutionReport(execution), true)
  assert.equal(isWorkflowExecutionReport({ ...execution, table: report.table }), false)
  const turn = { id: 'one', prompt: '检查端口', display: '实际检查结果'.repeat(150), error: '' }
  const events = [{ sequence: 1, kind: 'user', legacy_turn_id: 'one', payload: {} }, { sequence: 3, kind: 'visual_report', payload: { report_json: JSON.stringify(execution) } }, { sequence: 4, kind: 'assistant', legacy_turn_id: 'one', payload: {} }]
  const legacy = restoredMessages([turn], events)
  assert.equal(legacy.find(message => message.role === 'assistant').detail, false)
  assert.deepEqual(reportRecoveryRunIDs([...legacy, { id: 'error', role: 'error', text: '' }], 'error'), ['run-1'])
  const specialist = { id: 'workflow-run-1', kind: 'workflow', run_id: 'run-1', task: '端口查询', stage: 'completed', completed: 1, total: 1, steps: [{ id: 'step', name: '端口查询', resource: 'host', kind: 'ssh_command', status: 'completed' }] }
  const restored = restoredMessages([{ ...turn, specialists: [specialist] }], [...events, { sequence: 2, kind: 'workflow', payload: { run_id: 'run-1', name: '端口查询', status: 'completed', completed: 1, total: 1 } }])
  assert.equal(restored.filter(message => message.role === 'report').length, 0)
  assert.equal(restored.filter(message => message.role === 'specialist').length, 1)
  assert.equal(restored.find(message => message.role === 'specialist').specialist.steps[0].status, 'completed')
})

test('formatting recovery uses only this turn and does not disguise operational errors', () => {
  const error = '[NodeRunError] failed to invoke tool[name:lake_visual_report id:call_fixture]: tool input violates schema: missing title'
  assert.equal(isReportFormattingError(error), true)
  assert.equal(isReportFormattingError(error.replace('lake_visual_report', 'lake_workflow_run')), false)
  assert.equal(isReportFormattingError(error.replace('tool input violates schema: missing title', 'context canceled')), false)
  const messages = [{ id: 'old', role: 'user', text: '' }, { id: 'old-report', role: 'report', text: '', report: { ...execution, sources: ['运行记录：old-run'] } }, { id: 'current', role: 'user', text: '' }, { id: 'execution', role: 'report', text: '', report: execution }, { id: 'trace', role: 'specialist', text: '', specialist: { kind: 'workflow', run_id: 'run-1' } }, { id: 'bad', role: 'specialist', text: '', specialist: { kind: 'workflow', run_id: 'run-id\nunsafe' } }, { id: 'error', role: 'error', text: error }]
  assert.deepEqual(reportRecoveryRunIDs(messages, 'error'), ['run-1'])
})
