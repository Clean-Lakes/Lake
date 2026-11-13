---
goal: 修复专员未读入口并减少常规任务的无效模型往返
version: 1
date_created: 2026-11-11
last_updated: 2026-11-11
owner: Codex
status: Completed
tags: [frontend, backend, specialist, acp, bug]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

用户确认未读小圆点无法清除，并要求缩短任务流程；明确保留本机 Codex 的 max 思考配置。实际最近一次运行约 454 秒，ACP 启动约 4.5 秒，根 Worker 工具墙钟约 22 秒，包含两次因旧未决操作而失败的完成提交。本轮处理可见读取、后台汇合指引与准确完成诊断，不承诺模型服务延迟下降。

## 1. Requirements & Constraints

- **REQ-001**: 专员任务页提供准确频道的“标记已读”，仅确认用户点击时已交付的 cursor；失败可重试，新消息及其他频道保持未读。
- **REQ-002**: 已结束且有报告的任务优先打开结果；自动读取标记跟随报告正文，不被完整操作历史推到页尾。列表、后台窗口与执行过程本身不自动已读。
- **REQ-003**: 共享 Worker 指引要求常规检查有界采样、合并同目标独立只读观察、避免无收益拆分与重复记账；TaskOutput 描述使用原句柄有界等待，不引导读取子会话全文。
- **REQ-004**: finishHost 区分未决操作与缺少业务证据；未决提示准确指向 partial，不让模型用无关新检查反复尝试完成。
- **SEC-001**: 保留原权限、资源范围、期限、unknown、调用幂等与完成验收，不重放、不核实或改写旧业务记录。
- **CON-001**: 不修改本机 Codex 的登录、model 或 max；只安装签名 Lake Dev，不操作真实服务器或生产应用。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 修复读取交互与重复执行指引。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | ConversationReadMarker.tsx、SpecialistTaskList.tsx 增加有错误重试及 cursor 竞态保护的已读按钮；App.tsx、SessionInspector.tsx、WorkerExecutionTree.tsx 让结果正文的可见性触发共享自动读取。 | ✅ | 2026-11-11 |
| TASK-002 | tasks.ts 分离未决诊断；execution.ts、super-prompts.ts 调整 TaskOutput 与常规巡检指引，保留原 SDK 执行与验收。 | ✅ | 2026-11-11 |
| TASK-003 | tasks.test.ts 验证准确诊断、原操作不变及部分报告；虚构浏览器 fixture 验证显式已读、自动已读、频道切换、请求失败及新 cursor 竞态。依赖 TASK-001、TASK-002。 | ✅ | 2026-11-11 |

### Implementation Phase 2

- **GOAL-002**: 完成本地回归、签名 Dev 与审计。依赖 GOAL-001。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-004 | 运行前后端类型、相关回归、构建、宿主及固定 Codex 集成，使用 ego-browser 在虚构页面验证浅/深色、窄窗和键盘；记录实际结果。 | ✅ | 2026-11-11 |
| TASK-005 | 干净提交后用 scripts/build_lake_desktop.sh --dev --install；仅空闲时重启 Dev，验证来源与业务记录保留。依赖 TASK-004。 | ✅ | 2026-11-11 |
| TASK-006 | 更新 UI/运行说明、验证材料及原 develop 草稿 PR，保留未合并与模型延迟未实测的限制。依赖 TASK-005。 | ✅ | 2026-11-11 |

## 3. Alternatives

- **ALT-001**: 打开任务列表立即清除全频道：无法证明用户看过结果，采用显式按钮与报告可见性。
- **ALT-002**: 降低 max 或缩短原任务期限：用户明确保留本机 max，且超时不能替代流程优化。
- **ALT-003**: 用新成功检查解除旧 unknown：会破坏原验收合同，改为准确提示部分结果。

## 4. Dependencies

- **DEP-001**: 原 messages-read API 及 conversationReads 单调游标；原前台窗口读取接口。
- **DEP-002**: 原 SDK TaskOutput 的 block/timeout 与 LakeExecution 包装；不修改第三方 SDK。

## 5. Files

- **FILE-001**: web-agent/web/src/ConversationReadMarker.tsx、SpecialistTaskList.tsx、specialistTaskList.css、App.tsx、SessionInspector.tsx、WorkerExecutionTree.tsx。
- **FILE-002**: runtime/typescript/tasks.ts、tasks.test.ts、execution.ts、super-prompts.ts、acp.integration.test.cjs。
- **FILE-003**: web-agent/web/test/specialist-task-list.test.ts、fixtures/specialist-task-list.tsx、docs/ui-guidelines.md、runtime/typescript/README.md、docs/validation/acp-agent-execution/。

## 6. Testing

- **TEST-001**: 已读失败保留点并显示可重试错误；成功及刷新后不复现；进行中的新消息只确认原 cursor。
- **TEST-002**: 跳转另一专员、只浏览列表/执行、后台窗口不自动清点；最新结果实际可见后自动确认。
- **TEST-003**: 未决操作的完成提交返回明确 blocker；不新增工具调用或验收，partial 保留旧结果。
- **TEST-004**: 固定真实 Codex 仍继承 max，实际业务工具与任务验收链路继续通过；禁止真实外网模型或服务器测试。

## 7. Risks & Assumptions

- **RISK-001**: 指引能减少无效模型往返，但合成服务不能证明真实 max 模型耗时改善；不报告虚构加速百分比。
- **RISK-002**: 已读响应可能跨频道或落后于新消息，必须绑定原 session/cursor，不能全局乐观清零。
- **ASSUMPTION-001**: 原 develop 草稿 PR 与现有工作分支继续适用；生产发布和 PR 合并未获授权。

## 8. Related Specifications / Further Reading

- [UI 读取规则](../docs/ui-guidelines.md#专员任务页2026-11-11)
- [任务验收合同](../docs/security/task-confirmation.md)
- [ACP 兼容记录](../docs/validation/acp-agent-execution/compatibility.md)

已测试并安装的代码提交：`b77ab66b6664a9fe78dced26e90fd3a1f841e8f7`。前端 798、后端 268 / 4 既有可选跳过、宿主 192、固定真实 Codex + 合成模型 4 项通过。实际 Dev 未读点已清除，本机 max 配置哈希不变。旧内核退出挂起经私有快照及准确闲置进程清理完成安装，其根因仍未定位；1 条原遗留 running 命令按原启动恢复转为 unknown，规范操作未改变。验证与限制见 [本轮记录](../docs/validation/acp-agent-execution/specialist-read-latency.md)。[develop 草稿 PR #222](https://github.com/Clean-Lakes/Lake/pull/222) 已更新，未合并。
