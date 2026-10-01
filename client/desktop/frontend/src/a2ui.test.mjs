import test from 'node:test'
import assert from 'node:assert/strict'
import { UI_CATALOG, parseUISnapshot, upsertUISurface } from './a2ui.ts'
import { restoredMessages } from './timeline.ts'
const snapshot = { surfaceId: 'main', catalogId: UI_CATALOG, revision: 1, components: [{ id: 'root', component: 'Text', text: { path: '/value' } }], data: { value: '1' } }
test('A2UI updates the existing timeline panel and restoration keeps latest facts', () => {
 const events = [1, 2].map(revision => ({ sequence: revision, kind: 'a2ui', payload: { ui_json: JSON.stringify({ ...snapshot, revision, data: { value: String(revision) } }) } }))
 const messages = restoredMessages([], events)
 assert.equal(messages.length, 1); assert.equal(messages[0].ui.data.value, '2')
 assert.strictEqual(upsertUISurface(messages, snapshot, () => { throw Error('stale update') }), messages)
 assert.deepEqual(upsertUISurface(messages, { ...snapshot, revision: 3, deleted: true }, () => {}), [])
})
test('A2UI rejects executable components, cyclic trees and prototype paths', () => {
 assert.ok(parseUISnapshot(snapshot))
 for (const components of [[{ id: 'root', component: 'HTML', text: 'evil' }], [{ id: 'root', component: 'Column', children: ['root'] }], [{ id: 'root', component: 'Button', label: 'run', action: { event: { name: 'exec' } } }]]) assert.equal(parseUISnapshot({ ...snapshot, components }), null)
 assert.equal(parseUISnapshot({ ...snapshot, data: JSON.parse('{"__proto__":{}}') }), null)
 assert.equal(parseUISnapshot({ ...snapshot, revision: 0 }), null)
})
