---
goal: 图片和长对话自动适配输入预算并准确展示界面恢复
version: 1.0
date_created: 2026-10-01
last_updated: 2026-10-01
owner: Lake
status: 'Completed'
tags: [context, images, a2ui, recovery]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-green)

图片Base64被当成文字估算导致正常截图无法发送；最近八条长消息不可压缩也会阻塞继续对话。按视觉容量估算图片，按可用预算调整保留历史条数并分段摘要超大历史消息；界面格式调整使用中性提示，成功后的恢复保持可追溯。

## 1. Requirements & Constraints

- **REQ-001**: 图片预算不随Base64编码体积增长；当前用户文字及图片原样送入模型，不删除或重编码附件。
- **REQ-002**: KeepRecent是最大保留条数；超预算时压缩更近的历史，完整历史及来源仍保存，摘要作为不具授权效力的助手历史。
- **REQ-003**: 单条超大历史可分段摘要；模型请求中的摘要块、最终上下文均受预算限制，取消立即退出。
- **REQ-004**: 格式校验失败仍反馈模型自动修正，界面显示中性调整提示；成功重试显示恢复结果，真实操作失败保持失败状态。
- **SEC-001**: 不输出密钥和附件中的认证字段，不自动发送用户未请求的MCP配置，不重新执行远端工作流。
- **CON-001**: 使用签名构建脚本安装；重启前检查任务空闲并保留用户草稿。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 消息和历史预算适配。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | lake/agent/context.go实现图片视觉预留并避免重复计算多模态文字；compact.go依据固定输入和摘要预留动态缩减recent，分段超大历史；context_test.go覆盖截图、长recent、单条大历史及取消。 | Yes | 2026-10-01 |
| TASK-002 | cmd/lake/context_recovery_test.go增加长对话携带大编码截图的集成回归，确认附件原样发送且摘要持久化；README.md说明自动压缩。依赖TASK-001。 | Yes | 2026-10-01 |

### Implementation Phase 2

- **GOAL-002**: 格式调整及结果展示与真实状态一致。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | client/desktop/frontend/src/activity.ts提供严格展示校验类别判断；shared/ActivityLine.tsx、ActivityLine.css将invalid_ui及invalid_report显示为中性格式调整；activity.test.mjs验证成功恢复、跨轮隔离和真实失败；现有cmd/lake/visual_report_test.go集成验证模型收到纠正反馈并成功重试。 | Yes | 2026-10-01 |
| TASK-004 | 相关Go race/vet、前端测试及两类生产构建；浏览器验证调整中与已恢复界面；签名安装、空闲重启、清理预览。依赖TASK-002、TASK-003。 | Yes | 2026-10-01 |

## 3. Alternatives

- **ALT-001**: 增大模型窗口不能解决图片误算，也不能适配任意增长的历史；修正估算与压缩边界。
- **ALT-002**: 删除历史或用户附件会丢失资料；仅缩减模型上下文并持久化带来源摘要。

## 4. Dependencies

- **DEP-001**: 现有PrepareContext、配置模型摘要、会话摘要存储、A2UI格式纠正预算。
- **DEP-002**: 已有前端展示重试分组及受限工具授权。

## 5. Files

- **FILE-001**: lake/agent/context.go、compact.go、context_test.go。
- **FILE-002**: cmd/lake/context_recovery_test.go；README.md。既有bridge_test.go、visual_report_test.go继续作为回归验证。
- **FILE-003**: client/desktop/frontend/src/shared/ActivityLine.tsx、ActivityLine.css；client/desktop/frontend/src/activity.ts、activity.test.mjs；本计划。

## 6. Testing

- **TEST-001**: 图片实际内容保持一致，长Base64不触发文字预算，非ASCII文字不低估，超大当前文字依然拒绝。
- **TEST-002**: 长最近历史自动摘要、当前输入不变，来源去重且跨重载保留；分段摘要请求和最终上下文均不超预算。
- **TEST-003**: 格式失败可自动重试成功，调整中中性提示，最终恢复成功，真实操作失败不会被覆盖。
- **TEST-004**: 集成模型端收到截图及当前请求，签名构建和界面检查通过。

验证结果：`go test -race ./lake/agent ./lake/store ./cmd/lake`、对应`go vet`及前端38项测试通过。集成测试使用大于200KB编码的有效PNG与三轮超大中文历史，在8192 Token配置下确认摘要分段、原图原样到达模型、原始历史保留、六个来源事件持久化。浏览器验证实际组件的中性待调整、修正中、成功三种状态，格式提示不显示红色执行失败。签名脚本完成Web及桌面生产构建，安装`Lake-20261001-193238-43738.app`至`~/Applications/Lake.app`，空闲重启后原会话、侧栏335像素及空草稿保留；临时界面文件、页签和服务器已清理。未重跑任何远端任务，未提交截图中的MCP配置。

## 7. Risks & Assumptions

- **RISK-001**: 图片估算是本地预留而非提供商精确Token值；真实超大用户文字仍需明确提示。
- **ASSUMPTION-001**: 用户截图是延续此前修复请求；本次仅修复Lake，不将图中的MCP认证信息用于外部连接。

## 8. Related Specifications / Further Reading

[自主规划](feature-workflow-planning-1.md)
[构建规则](../AGENTS.md)
