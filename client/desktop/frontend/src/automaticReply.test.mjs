import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { automaticReplySurfaces, replyTextChunks } from './automaticReply.ts'
import { parseUISnapshot } from './a2ui.ts'

const nodes = surfaces => surfaces.flatMap(surface => surface.components)
const ofType = (surfaces, name) => nodes(surfaces).filter(component => component.component === name)
const facts = surfaces => Object.assign({}, ...surfaces.map(surface => surface.data))

test('historical reply presentation remains compatible', () => {
 const fixture = JSON.parse(readFileSync(new URL('./fixtures/a2ui-automatic-reply.json', import.meta.url), 'utf8'))
 assert.deepEqual(automaticReplySurfaces(fixture.answer, 'fixture'), fixture.surfaces)
})

test('every ordinary reply has a stable A2UI view without inventing metrics or actions', () => {
 const text = '你好。可以先确认你想检查哪一台主机。'
 const views = automaticReplySurfaces(text, 'message')
 assert.equal(views.length, 1)
 assert.ok(views.every(parseUISnapshot))
 assert.equal(ofType(views, 'Markdown').length, 1)
 assert.equal(Object.values(facts(views)).join(''), text)
 assert.equal(nodes(views).some(component => component.action), false)
 assert.deepEqual(automaticReplySurfaces(text, 'message'), views)
 assert.notEqual(automaticReplySurfaces(text, 'other-conversation:message')[0].surfaceId, views[0].surfaceId)
 assert.equal(ofType(views, 'Metric').length + ofType(views, 'Chart').length, 0)
})

test('headings, ordered steps and code become native components with their original content', () => {
 const text = '# 检查步骤\n\n3. 先确认资源授权。\n4. 再检查端口。\n\n## 查询命令\n\n```sh\nss -H -lntup\n```'
 const views = automaticReplySurfaces(text, 'steps')
 assert.ok(views.every(parseUISnapshot))
 assert.deepEqual(ofType(views, 'Card').map(card => card.title), ['检查步骤', '查询命令'])
 const list = ofType(views, 'List')[0]
 assert.equal(list.start, 3); assert.equal(list.ordered, true)
 assert.deepEqual(facts(views)[list.id], ['先确认资源授权。', '再检查端口。'])
 const code = ofType(views, 'Code')[0]
 assert.equal(code.language, 'sh'); assert.equal(facts(views)[code.id], 'ss -H -lntup')
 const inline = automaticReplySurfaces('要运行 `echo "a|b"`，请先确认。', 'inline')
 assert.equal(Object.values(facts(inline)).join(''), '要运行 `echo "a|b"`，请先确认。')
})

test('explicit percentages generate correctly scaled chart and complete table tabs', () => {
 const views = automaticReplySurfaces('| 主机 | CPU占用 | 说明 |\n| --- | --- | --- |\n| 示例一 | 25% | 已采样 |\n| 示例二 | 75% | 已采样 |', 'percent')
 assert.ok(views.every(parseUISnapshot))
 const chart = ofType(views, 'Chart')[0], table = ofType(views, 'Table')[0]
 assert.equal(chart.max, 100); assert.equal(chart.unit, '%')
 assert.deepEqual(facts(views)[chart.id], [{ label: '示例一', value: 25 }, { label: '示例二', value: 75 }])
 assert.deepEqual(table.headers, ['主机', 'CPU占用', '说明'])
 assert.deepEqual(facts(views)[table.id].map(row => Object.values(row)), [['示例一', '25%', '已采样'], ['示例二', '75%', '已采样']])
 assert.deepEqual(ofType(views, 'Tabs')[0].labels, ['概览', '详细清单'])
 for (const values of [['不确定', '未检查'], ['101%', '25%'], ['1.2', '2.0'], ['运行中', '已退出']]) {
  const unclear = automaticReplySurfaces(`| 主机 | 状态 |\n| --- | --- |\n| 一 | ${values[0]} |\n| 二 | ${values[1]} |`, 'unclear')
  assert.equal(ofType(unclear, 'Chart').length, 0)
 }
})

test('complex references retain their source and large Unicode answers are bounded without truncation', () => {
 const references = '查看[文档][ref]。\n\n[ref]: https://example.invalid/docs'
 const views = automaticReplySurfaces(references, 'references')
 assert.equal(Object.values(facts(views)).join(''), references)
 const long = '中文😀内容'.repeat(6000)
 assert.equal(replyTextChunks(long).join(''), long)
 assert.ok(replyTextChunks(long).every(part => Buffer.byteLength(part) <= 8000))
 const bounded = automaticReplySurfaces(long, 'long')
 assert.ok(bounded.length > 1)
 assert.ok(bounded.every(parseUISnapshot))
 assert.equal(Object.values(facts(bounded)).join(''), long)
 assert.ok(bounded.every(surface => Buffer.byteLength(JSON.stringify(surface)) < 48 * 1024))
})

test('long lists and tables retain all rows, literal pipes and empty values', () => {
 const list = automaticReplySurfaces(Array.from({length:250}, (_, i) => `${i + 1}. 记录${i}`).join('\n'), 'long-list')
 assert.equal(ofType(list, 'List').length, 2)
 assert.deepEqual(ofType(list, 'List').map(node => node.start), [1, 201])
 assert.equal(ofType(list, 'List').flatMap(node => facts(list)[node.id]).length, 250)
 const table = automaticReplySurfaces('| 记录 | 命令 |\n| --- | --- |\n' + Array.from({length:230}, (_, i) => `| ${i} | ${i === 0 ? '`a\\|b`' : ''} |`).join('\n'), 'long-table')
 const rows = ofType(table, 'Table').flatMap(node => facts(table)[node.id])
 assert.equal(rows.length, 230)
 assert.equal(rows[0]['column-1'], 'a|b')
 assert.equal(rows[1]['column-1'], '')
 assert.ok([...list, ...table].every(parseUISnapshot))
})
