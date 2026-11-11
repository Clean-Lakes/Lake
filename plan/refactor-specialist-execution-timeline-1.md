---
goal: 修正专员会话旧执行卡片落在最新回复之后的顺序
version: 1
date_created: 2026-11-11
last_updated: 2026-11-11
owner: Lake
status: 'In progress'
tags: [fix, frontend, acp, timeline]
---

# Introduction

![Status: In progress](https://img.shields.io/badge/status-In%20progress-yellow)

用户截图中的旧原生任务卡被追加到今天 Codex 回复之后，造成新任务仍用原生的误解。实际 2026-11-11 09:14（Asia/Shanghai）的新任务已有 completed Codex 运行。仅修正前端的任务卡投影顺序，保留真实执行者及原任务记录。

## 1. Requirements & Constraints

- **REQ-001**: 没有可见回复的任务卡按 execution.assignedAt / worker.createdAt 插入原会话时间位置；最新 Codex 回复之后不得追加旧原生卡。
- **REQ-002**: 有正文的任务不重复显示分配卡；隐藏的内部派单不视为公开回复。相同标题按 task/session ID 区分。
- **REQ-003**: 分页时不提前展示尚未加载范围外的旧卡；新排队/活动任务仍显示执行绑定，后续出现正文时替换占位。
- **SEC-001**: 不改变 Task/Worker、执行后端、回执和验收，不重放任何服务器操作。
- **CON-001**: 延用现有分支和 PR #222 到 develop；签名安装 Lake Dev，不合并、不发布。
- **GUD-001**: 复用 AgentExecution、现有任务分隔线与任务详情入口；验证明暗、窄窗和最新回复位置。
- **PAT-001**: 展示项采用临时前端联合类型，分配卡不伪造聊天消息或 SDK 事件。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 修正时间投影并证明旧卡不会占用最新回复位置；任务顺序执行。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | 在 web-agent/web/src/specialistChannelProjection.ts 新增 channelExecutionTimeline，按原创建时间合并可见回复与无正文 Worker；分页保留范围和活动任务，身份使用原 task/session。 | Yes | 2026-11-11 |
| TASK-002 | 在 SpecialistChannel.tsx 中将执行占位纳入 SpecialistChannelEntries，删除尾部追加；不改变已存在的正文分组、历史折叠和任务入口。依赖 TASK-001。 | Yes | 2026-11-11 |
| TASK-003 | 在 web-agent/web/test/specialist-channel.test.ts 和 specialist-channel-projection.test.ts 覆盖旧原生卡/新 Codex 回复顺序、分页、排队转正文、同标题及旧条目缺 taskId；执行完整前端测试和类型构建。依赖 TASK-002。 | Yes | 2026-11-11 |

### Implementation Phase 2

- **GOAL-002**: 验证可见结果并交付；依赖 Phase 1。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-004 | 用独立浏览器夹具验证旧卡在历史位置、Codex 结果在底部、明暗与窄窗；空闲后经签名脚本安装 Lake Dev，核对真实频道最新 Codex 卡与旧 Worker 绑定。 | | |
| TASK-005 | 在 docs/validation/acp-agent-execution 记录修复、准确 SHA 与检查，更新草稿 PR #222；保持 develop/master 和正式版不变。依赖 TASK-004。 | | |

## 3. Alternatives

- **ALT-001**: 将历史原生绑定改为 Codex 会伪造执行记录，拒绝。
- **ALT-002**: 仅隐藏所有无正文任务会掩盖排队和失败状态，采用按时间插入。

## 4. Dependencies

- **DEP-001**: 现有 SpecialistChannelEntry、SuperWorker 和 AgentExecutionSummary 的稳定身份及 assignedAt。

## 5. Files

- **FILE-001**: web-agent/web/src/specialistChannelProjection.ts 和 SpecialistChannel.tsx。
- **FILE-002**: web-agent/web/test/specialist-channel.test.ts、specialist-channel-projection.test.ts、隔离浏览器夹具及 docs/validation/acp-agent-execution/。

## 6. Testing

- **TEST-001**: 原生旧任务无消息时仍保留在历史位置，最新 Codex 实际报告为最后一项；输入数据不被修改。
- **TEST-002**: 分页不提前插入更老的占位，排队卡保留且到真实回复后只出现一次；同名任务不合并。
- **TEST-003**: 完整前端、类型与构建、命名/边界；浏览器明暗/窄窗及签名 Dev 可见顺序，旧执行绑定不变。

## 7. Risks & Assumptions

- **RISK-001**: 旧记录可能缺少 assignedAt 或 createdAt；未知时间只在完整历史前部展示，不假定它是最新任务。
- **ASSUMPTION-001**: 已保存任务的执行者显示原实际绑定，聊天框模型选择仅决定新任务。

## 8. Related Specifications / Further Reading

- [前端规范](../docs/ui-guidelines.md)
- [ACP 当前验证](../docs/validation/acp-agent-execution/compatibility.md)
