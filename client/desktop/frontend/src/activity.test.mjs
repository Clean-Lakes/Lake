import assert from 'node:assert/strict'
import test from 'node:test'
import { activityLabel, applyActivityEvent, canGroupActivities, canGroupPresentationActivities, groupedActivityLabel, groupedActivityStatus, isPresentationFormatRejection, settleActivities, toolAction } from './activity.ts'
import { readdirSync, readFileSync } from 'node:fs'
import { restoredMessages } from './timeline.ts'

const start = (sequence, id, name, detail = '') => ({ sequence, kind: 'tool_proposed', tool_call_id: id, payload: { tool_name: name, preview: detail } })
const finish = (sequence, id, status) => ({ sequence, kind: 'tool_finished', tool_call_id: id, payload: { status, duration_ms: 1250 } })

test('UI format retries summarize their final state while retaining failed attempts', () => {
  let messages = applyActivityEvent([], start(1, 'rejected', 'lake_ui'), 'turn')
  const failure = finish(2, 'rejected', 'failed'); failure.payload.error_code = 'invalid_ui'
  messages = applyActivityEvent(messages, failure, 'turn')
  assert.equal(activityLabel(messages[0].activity), '界面格式待修正')
  messages = applyActivityEvent(messages, start(3, 'retry', 'lake_ui'), 'turn')
  assert.equal(canGroupPresentationActivities([messages[0].activity], messages[1].activity), true)
  assert.equal(groupedActivityLabel(messages.map(item => item.activity)), '正在调整界面')
  assert.equal(groupedActivityStatus(messages.map(item => item.activity)), 'running')
  messages = applyActivityEvent(messages, finish(4, 'retry', 'completed'), 'turn')
  const activities = messages.map(item => item.activity)
  assert.equal(groupedActivityLabel(activities), '界面已展示 · 1 次调整')
  assert.equal(groupedActivityStatus(activities), 'completed')
  assert.equal(activities[0].status, 'failed')
  assert.equal(activities[0].errorCode, 'invalid_ui')
  assert.equal(canGroupActivities([activities[0]], activities[1]), false)
  const events = [{ sequence: 0, kind: 'user', payload: { preview: '再试一次' } }, start(1, 'rejected', 'lake_ui'), failure, start(3, 'retry', 'lake_ui'), finish(4, 'retry', 'completed')]
  const restored = restoredMessages([], events).filter(item => item.activity).map(item => item.activity)
  assert.equal(canGroupPresentationActivities([restored[0]], restored[1]), true)
  assert.equal(groupedActivityStatus(restored), 'completed')
})

test('UI retry grouping respects turn, tool, successful updates and operational failure', () => {
  const rejected = { ...applyActivityEvent([], start(1, 'a', 'lake_ui'), 'turn')[0].activity, status: 'failed', errorCode: 'invalid_ui' }
  const completed = { ...rejected, id: 'b', status: 'completed', errorCode: undefined }
  assert.equal(isPresentationFormatRejection(rejected), true)
  assert.equal(isPresentationFormatRejection(completed), false)
  assert.equal(isPresentationFormatRejection({ ...rejected, tool: 'lake_workflow_run' }), false)
  assert.equal(isPresentationFormatRejection({ ...rejected, errorCode: 'presentation_unavailable' }), false)
  assert.equal(canGroupPresentationActivities([rejected], completed), true)
  assert.equal(canGroupPresentationActivities([{ ...rejected, errorCode: undefined }], completed), true)
  assert.equal(canGroupPresentationActivities([{ ...rejected, errorCode: undefined }], { ...completed, status: 'running' }), false)
  assert.equal(canGroupPresentationActivities([{ ...rejected, errorCode: 'presentation_unavailable' }], completed), false)
  assert.equal(canGroupPresentationActivities([rejected], { ...completed, turnID: 'another' }), false)
  assert.equal(canGroupPresentationActivities([rejected], { ...completed, tool: 'lake_visual_report' }), false)
  assert.equal(canGroupPresentationActivities([completed], completed), false)
  assert.equal(canGroupPresentationActivities([rejected, completed], completed), false)
  assert.equal(canGroupPresentationActivities([rejected], { ...completed, status: 'unknown' }), false)
  assert.equal(canGroupPresentationActivities([rejected], { ...completed, status: 'failed', errorCode: 'presentation_unavailable' }), false)
})

test('tool starts and finishes update one row and preserve failures and duration', () => {
  let messages = applyActivityEvent([], start(1, 'read', 'lake_code_read', 'main.go'), 'turn')
  assert.equal(activityLabel(messages[0].activity), '正在读取文件')
  messages = applyActivityEvent(messages, finish(2, 'read', 'failed'), 'turn')
  assert.equal(messages.length, 1)
  assert.equal(activityLabel(messages[0].activity), '读取文件失败')
  assert.equal(messages[0].activity.detail, 'main.go')
  assert.equal(messages[0].activity.durationMS, 1250)
  assert.deepEqual(applyActivityEvent(messages, start(1, 'read', 'lake_code_read'), 'turn'), messages)
  assert.deepEqual(applyActivityEvent(messages, finish(2, 'read', 'completed'), 'turn'), messages)
})

test('same call ID in another turn cannot complete an earlier call', () => {
  let messages = applyActivityEvent([], start(1, 'same', 'lake_code_read'), 'old')
  messages = applyActivityEvent(messages, start(2, 'same', 'lake_code_run'), 'new')
  messages = applyActivityEvent(messages, finish(3, 'same', 'completed'), 'new')
  assert.equal(messages[0].activity.status, 'running')
  assert.equal(messages[1].activity.status, 'completed')
  messages = settleActivities(messages, 'old')
  assert.equal(messages[0].activity.status, 'unknown')
  assert.equal(messages[1].activity.status, 'completed')
})

test('only adjacent completed read/search/command activity from one turn can group', () => {
  let messages = []
  for (const [index, name] of ['lake_code_read', 'lake_code_search', 'lake_code_run'].entries()) {
    messages = applyActivityEvent(messages, start(index * 2 + 1, String(index), name), 'turn')
    messages = applyActivityEvent(messages, finish(index * 2 + 2, String(index), 'completed'), 'turn')
  }
  const activities = messages.map(message => message.activity)
  assert.equal(canGroupActivities(activities.slice(0, 2), activities[2]), true)
  assert.equal(groupedActivityLabel(activities), '已读取 1 个文件，搜索 1 次，运行 1 条命令')
  assert.equal(canGroupActivities(activities.slice(0, 2), { ...activities[2], status: 'failed' }), false)
  assert.equal(canGroupActivities(activities.slice(0, 2), { ...activities[2], turnID: 'another' }), false)
})

test('saved activity keeps chronology and unfinished history becomes unknown', () => {
  const events = [
    { sequence: 1, kind: 'user', payload: { preview: '查代码' } },
    { sequence: 2, kind: 'run_started', payload: {} },
    { sequence: 3, kind: 'assistant_progress', payload: { preview: '先读取文件。' } },
    start(4, 'read', 'lake_code_read', 'main.go'),
    finish(5, 'read', 'completed'),
    { sequence: 6, kind: 'summary_created', payload: { token_estimate: 230 } },
    { sequence: 7, kind: 'assistant_progress', payload: { preview: '然后运行检查。' } },
    start(8, 'command', 'lake_code_run', 'go test ./...'),
  ]
  const history = restoredMessages([], events)
  assert.deepEqual(history.map(message => message.role), ['user', 'assistant', 'activity', 'activity', 'assistant', 'activity'])
  assert.equal(history[2].activity.status, 'completed')
  assert.equal(activityLabel(history[3].activity), '上下文已自动压缩')
  assert.equal(history[5].activity.status, 'unknown')
  assert.equal(restoredMessages([], events, { live: true }).at(-1).activity.status, 'running')
  const ended = restoredMessages([], [...events, { sequence: 9, kind: 'answer_finished', payload: { status: 'completed' } }], { live: true })
  assert.equal(ended.at(-1).activity.status, 'unknown')
})

test('dedicated specialist, question, approval and MCP cards do not gain duplicate progress rows', () => {
  for (const name of ['lake_ssh_agent', 'lake_code_agent', 'lake_specialist_database', 'lake_ask_user', 'mcp_tool', 'ssh']) {
    assert.deepEqual(applyActivityEvent([], start(1, 'call', name), 'turn'), [])
  }
  const activities = applyActivityEvent([], start(1, 'call', 'lake_script_status'), 'turn')
  const queried = applyActivityEvent(activities, finish(2, 'call', 'completed'), 'turn')
  assert.equal(activityLabel(queried[0].activity), '已查询长任务')
})

test('native tools use explicit actions in the existing timeline', () => {
 for (const name of ['Bash','Read','Write','Edit','Grep','Glob','Agent','Skill','AskUserQuestion']) assert.notEqual(toolAction(name).kind,'tool',`missing native activity: ${name}`)
})

test('read, list, edit, create, delete, restore and checks retain explicit action and outcome', () => {
  const cases = [
    ['lake_code_read', '读取文件'], ['lake_code_list', '列出文件'], ['lake_code_search', '搜索代码'],
    ['lake_code_edit', '编辑文件'], ['lake_code_create', '创建文件'], ['lake_code_patch', '修改文件'],
    ['lake_code_restore', '恢复文件检查点'], ['lake_code_checkpoint', '保存文件检查点'],
    ['lake_code_status', '检查代码状态'], ['lake_code_diff', '查看代码差异'],
    ['lake_remote_code_read', '读取远程文件'], ['lake_remote_code_write', '写入远程文件'],
    ['lake_workflow_create', '创建工作流'], ['lake_workflow_update', '编辑工作流'],
    ['lake_workflow_v2_validate', '校验工作流'], ['lake_workflow_v2_events', '读取工作流轨迹'],
    ['lake_script_read', '读取脚本'], ['lake_pdf_read', '读取 PDF'], ['lake_browser_close', '关闭浏览器会话'],
  ]
  for (const [tool, action] of cases) {
    const messages = applyActivityEvent([], start(1, 'call', tool, 'target'), 'turn')
    assert.equal(activityLabel(messages[0].activity), `正在${action}`)
    for (const [status, label] of [['completed', `已${action}`], ['failed', `${action}失败`], ['cancelled', `${action}已取消`], ['unknown', `${action} · 结果未知`]]) {
      const finished = applyActivityEvent(messages, finish(2, 'call', status), 'turn')
      assert.equal(activityLabel(finished[0].activity), label)
      assert.equal(finished[0].activity.detail, 'target')
    }
  }
  assert.equal(toolAction('lake_future_tool').action, '调用 lake_future_tool')
})

test('file changes use actual event action, keep targets and accurate multi-file counts', () => {
  const activities = []
  for (const [i, name, kind, action, count, preview] of [
    [0, 'lake_code_edit', 'edit', '编辑文件', 1, 'main.go'],
    [1, 'lake_code_create', 'create', '创建文件', 1, 'new.go'],
    [2, 'lake_code_patch', 'delete', '删除文件', 2, 'old.go（删除）、unused.go（删除）'],
  ]) {
    const event = start(i * 2 + 1, `${i}`, name, preview)
    Object.assign(event.payload, { activity_kind: kind, activity_action: action, activity_count: count })
    const messages = applyActivityEvent([], event, 'turn')
    assert.equal(activityLabel(messages[0].activity), `正在${action}`)
    const done = applyActivityEvent(messages, finish(i * 2 + 2, `${i}`, 'completed'), 'turn')[0].activity
    assert.equal(done.detail, preview)
    activities.push(done)
  }
  assert.equal(canGroupActivities(activities.slice(0, 2), activities[2]), true)
  assert.equal(groupedActivityLabel(activities), '已编辑 1 个文件，创建 1 个文件，删除 2 个文件')
  assert.equal(canGroupActivities(activities, { ...activities[0], tool: 'lake_workflow_update' }), false)
  const running = { ...activities[0], status: 'running' }
  assert.equal(canGroupActivities(activities, running), false)
})
