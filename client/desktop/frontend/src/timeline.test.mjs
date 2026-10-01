import assert from 'node:assert/strict'
import test from 'node:test'
import { restoredMessages } from './timeline.ts'
import { parseWorkflowPlanning, workflowWaitLabel } from './workflowPlanning.ts'

test('workflow AI changes survive progress completion and event-only restoration', () => {
  const planning = { status: 'adjusted', message: 'AI 已调整 1 项执行配置', adjustments: [{ step_id: 'scan', step_name: '目录扫描', timeout_before_seconds: 20, timeout_seconds: 300, reason: '此前等待超时', wait_for: ['磁盘检查'] }] }
  const events = [
    { sequence: 1, kind: 'user', payload: { preview: '运行巡检' } },
    { sequence: 2, kind: 'run_started', payload: { model: 'test' } },
    { sequence: 3, kind: 'workflow', payload: { run_id: 'run-1', name: '巡检', status: 'planning', completed: 0, total: 2 } },
    { sequence: 4, kind: 'workflow', payload: { run_id: 'run-1', name: '巡检', status: 'running', completed: 0, total: 2, planning_json: JSON.stringify(planning) } },
    { sequence: 5, kind: 'workflow', payload: { run_id: 'run-1', name: '巡检', status: 'completed', completed: 2, total: 2 } },
  ]
  const call = restoredMessages([], events).find(item => item.specialist)?.specialist
  assert.equal(call.stage, 'completed')
  assert.deepEqual(call.planning, planning)
  assert.equal(workflowWaitLabel(20), '20 秒')
  assert.equal(workflowWaitLabel(300), '5 分钟')
  assert.equal(workflowWaitLabel(90), '1 分 30 秒')
  assert.equal(parseWorkflowPlanning('{'), undefined)
  assert.equal(parseWorkflowPlanning({ ...planning, adjustments: [{ ...planning.adjustments[0], timeout_seconds: 10 }] }), undefined)
})

test('question answers restore inline and unfinished historical questions cannot be submitted', () => {
  const questions = [{ id: 'target', header: '目标', prompt: '选择哪个 nginx' }]
  const events = [{ sequence: 1, kind: 'question_asked', payload: { question_id: 'q1', questions_json: JSON.stringify(questions) } }, { sequence: 2, kind: 'question_answered', payload: { question_id: 'q1', answers_json: JSON.stringify({ target: '宿主' }) } }, { sequence: 3, kind: 'question_asked', payload: { question_id: 'q2', questions_json: JSON.stringify(questions) } }]
  const messages = restoredMessages([], events)
  assert.equal(messages[0].question.status, 'answered')
  assert.deepEqual(messages[0].question.answers, { target: '宿主' })
  assert.equal(messages[1].question.status, 'interrupted')
})

test('empty conversations and legacy null events restore without a startup error', () => {
  assert.deepEqual(restoredMessages([], null), [])
  assert.deepEqual(restoredMessages(null, null), [])
  assert.deepEqual(restoredMessages(undefined), [])
  const turns = [{ id: 'legacy', prompt: 'question', answer: 'answer', display: 'answer', error: '' }]
  assert.deepEqual(restoredMessages(turns, null).map(item => item.role), ['user', 'assistant'])
})

test('versioned events restore the call between its user and assistant messages', () => {
  const turns = [{ id: 'turn-1', prompt: 'full question', answer: 'answer', display: 'answer', error: '', specialists: [{ id: 'call-1', kind: 'ssh', task: 'inspect', stage: 'completed' }] }]
  const events = [
    { sequence: 1, kind: 'user', legacy_turn_id: 'turn-1', payload: { preview: 'full question' } },
    { sequence: 2, kind: 'run_started', payload: { model: 'test' } },
    { sequence: 3, kind: 'tool_proposed', tool_call_id: 'call-1', payload: { tool_name: 'lake_ssh_agent' } },
    { sequence: 4, kind: 'tool_finished', tool_call_id: 'call-1', payload: { status: 'completed' } },
    { sequence: 5, kind: 'assistant', legacy_turn_id: 'turn-1', payload: { preview: 'answer' } },
  ]
  const restored = restoredMessages(turns, events)
  assert.deepEqual(restored.map(item => item.role), ['user', 'specialist', 'assistant'])
  assert.equal(restored[0].text, 'full question')
  assert.equal(restored[1].specialist.stage, 'completed')
})

test('legacy turns and unfinished user events remain visible', () => {
  const legacy = [{ id: 'old', prompt: 'old question', answer: 'old answer', display: 'old answer', error: '' }]
  assert.deepEqual(restoredMessages(legacy, []).map(item => item.role), ['user', 'assistant'])
  const unfinished = restoredMessages([], [{ sequence: 1, kind: 'user', payload: { preview: 'new question' } }, { sequence: 2, kind: 'run_failed', payload: { reason: 'failed' } }])
  assert.deepEqual(unfinished.map(item => item.role), ['user', 'error'])
})

test('MCP calls restore as named rows with their final status', () => {
  const turns = [{ id: 'turn-mcp', prompt: '查手册', answer: '找到了', display: '找到了', error: '' }]
  const events = [
    { sequence: 1, kind: 'user', legacy_turn_id: 'turn-mcp', payload: { preview: '查手册' } },
    { sequence: 2, kind: 'assistant_progress', payload: { preview: '我来查知识库。' } },
    { sequence: 3, kind: 'tool_proposed', tool_call_id: 'call-1', payload: { tool_name: 'mcp_zmy_list_collections', mcp_server: 'zmy', mcp_tool: 'list_collections' } },
    { sequence: 4, kind: 'tool_proposed', tool_call_id: 'turn-mcp-approval-1', payload: { tool_name: 'mcp' } },
    { sequence: 5, kind: 'tool_decision', tool_call_id: 'turn-mcp-approval-1', payload: { outcome: 'approved' } },
    { sequence: 6, kind: 'tool_finished', tool_call_id: 'call-1', payload: { status: 'completed' } },
    { sequence: 7, kind: 'assistant', legacy_turn_id: 'turn-mcp', payload: { preview: '找到了' } },
  ]
  const restored = restoredMessages(turns, events)
  assert.deepEqual(restored.map(item => item.role), ['user', 'assistant', 'mcp', 'assistant'])
  assert.equal(restored[2].mcp.server, 'zmy')
  assert.equal(restored[2].mcp.tool, 'list_collections')
  assert.equal(restored[2].mcp.status, 'completed')
})

test('terminal commands restore in sequence with one final card and unfinished work stays unknown', () => {
  const payload = { id: 'run-1', command: 'pwd', scope_id: 'project', target: '本机', session_id: 'shell', working_directory: '/app', stdout: '/app', stderr: '', exit_code: 0, status: 'running' }
  const events = [
    { sequence: 1, kind: 'user', payload: { preview: '检查项目' } },
    { sequence: 2, kind: 'execution_started', actor: 'agent', payload },
    { sequence: 3, kind: 'execution_finished', actor: 'agent', payload: { ...payload, status: 'completed' } },
    { sequence: 4, kind: 'assistant', payload: { preview: '已检查' } },
    { sequence: 5, kind: 'execution_started', actor: 'user', payload: { ...payload, id: 'run-2' } },
  ]
  const messages = restoredMessages([], events)
  assert.deepEqual(messages.map(item => item.role), ['user', 'execution', 'assistant', 'execution'])
  assert.equal(messages[1].execution.sequence, 3)
  assert.equal(messages[1].execution.actor, 'agent')
  assert.equal(messages[1].execution.status, 'completed')
  assert.equal(messages[3].execution.status, 'unknown')
})
