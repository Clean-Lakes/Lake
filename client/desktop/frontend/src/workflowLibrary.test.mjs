import assert from 'node:assert/strict'
import test from 'node:test'
import { canMoveWorkflow, workflowDropRequest } from './workflowLibrary.ts'

const entry = (kind, id, parent_id = '', lake_id = 'lake') => ({ kind, id, parent_id, lake_id, lake: lake_id, name: id, position: 0 })
const folder = entry('folder', 'parent'), child = entry('folder', 'child', 'parent')
const first = entry('v1', 'a'), second = entry('v2', 'b'), third = entry('v2', 'c')
const entries = [folder, child, first, second, third]

test('dragging folders cannot create cycles or change lake scope', () => {
  assert.equal(canMoveWorkflow(entries, folder, 'lake', 'child'), false)
  assert.equal(canMoveWorkflow(entries, folder, 'lake', 'parent'), false)
  assert.equal(canMoveWorkflow(entries, first, 'other', ''), false)
  assert.equal(canMoveWorkflow(entries, child, 'lake', ''), true)
  assert.equal(canMoveWorkflow(entries, first, 'lake', 'child'), true)
  assert.equal(canMoveWorkflow(entries, first, 'lake', 'missing'), false)
})

test('row edges sort siblings and the folder center moves inside', () => {
  assert.deepEqual(workflowDropRequest(entries, first, second, 'after'), { action: 'move', lake: 'lake', kind: 'v1', id: 'a', parent_id: '', before_kind: 'v2', before_id: 'c' })
  assert.equal(workflowDropRequest(entries, third, first, 'before').before_id, 'a')
  assert.equal(workflowDropRequest(entries, first, child, 'inside').parent_id, 'child')
  assert.equal(workflowDropRequest(entries, folder, child, 'inside'), null)
  assert.equal(workflowDropRequest(entries, first, second, 'inside'), null)
  assert.equal(workflowDropRequest(entries, first, first, 'before'), null)
})
