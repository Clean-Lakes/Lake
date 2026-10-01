import assert from 'node:assert/strict'
import test from 'node:test'
import { appendEventPage } from './eventCursor.ts'

const event = sequence => ({ version: 1, session_id: 'session', sequence, kind: 'assistant', payload: {} })

test('reconnect appends only unseen ordered events', () => {
  const initial = appendEventPage([], 0, [event(1), event(2)], 'session')
  const resumed = appendEventPage(initial.events, initial.cursor, [event(2), event(3)], 'session')
  assert.deepEqual(resumed.events.map(item => item.sequence), [1, 2, 3])
  assert.equal(resumed.cursor, 3)
})

test('rejects gaps or another session', () => {
  assert.throws(() => appendEventPage([], 0, [event(2)], 'session'), /不连续/)
  assert.throws(() => appendEventPage([], 0, [event(1)], 'other'), /不匹配/)
})
