import { test } from 'node:test'
import assert from 'node:assert/strict'
import { workflowTraceSummary, workflowStepMessage } from './workflowTrace.ts'

test('terminal count does not count unknown scan results as success', () => {
  const call = { stage: 'failed', completed: 9, total: 9, steps: [...Array.from({ length: 7 }, () => ({ status: 'completed' })), { status: 'unknown' }, { status: 'unknown' }] }
  assert.equal(workflowTraceSummary(call), '部分完成 7/9 · 2 项结果未知')
  assert.equal(workflowTraceSummary({ stage: 'failed', completed: 9, total: 9 }), '已中断 · 已结束 9/9')
})

test('failures, skipped and cancelled steps are separate from completed work', () => {
  assert.equal(workflowTraceSummary({ stage: 'failed', total: 4, steps: ['completed', 'failed', 'skipped', 'cancelled'].map(status => ({ status })) }), '部分完成 1/4 · 1 项失败，1 项取消，1 项跳过')
  assert.equal(workflowTraceSummary({ stage: 'working', total: 2, steps: [{ status: 'completed' }, { status: 'running' }] }), '执行中 · 完成 1/2')
})

test('deadline errors explain uncertainty without asserting a remote failure', () => {
  const timeout = '工作流执行结果未知，禁止自动重放: SSH 执行结果未知: SSH 操作超时或取消: context deadline exceeded'
  assert.equal(workflowStepMessage({ status: 'unknown', message: timeout }), '等待执行结果超时，尚未确认远端命令是否结束')
  assert.equal(workflowStepMessage({ status: 'failed', message: '未获批准' }), '未获批准')
})
