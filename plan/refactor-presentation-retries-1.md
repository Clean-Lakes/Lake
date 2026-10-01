---
goal: 修复工作流图形化反复失败并统一 A2UI 展示入口
version: 1.0
date_created: 2026-10-01
last_updated: 2026-10-01
owner: Lake
status: 'Completed'
tags: [bug, a2ui, workflow]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-green)

工作流已成功执行后，旧报告工具仍被提示强制调用，连续返回 invalid_report。统一实际可用的展示工具，在两次格式失败后关闭本轮工具并直接生成可自动展示的正文。

## 1. Requirements & Constraints

- **REQ-001**: A2UI 会话只公开 lake_ui；不同时向模型公开两套报告参数。
- **REQ-002**: 每轮最多两次无效展示调用；之后使用已有事实输出 Markdown，客户端自动映射 UI；下一轮恢复工具。
- **REQ-003**: 工作流执行后的分析和已有结果整理只公开展示与保存记录查询工具，禁止重复执行工作流或远端命令。
- **SEC-001**: 保留 schema、安全目录、审批、取消与持久化错误语义；不读取或输出真实凭据，不查询真实主机。
- **CON-001**: 兼容没有 A2UI 通道的旧报告入口；原会话和历史报告继续可读。
- **CON-002**: 使用签名构建脚本更新已安装应用，只保留一个验证通过的构建。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 修复提示和展示失败控制。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | 在 cmd/lake/chat.go 按 UISession/PresentUI 选择展示工具；在 workflow_adaptive.go 移除旧工具的强制提示；工作流分析使用只读工具集合。 | Yes | 2026-10-01 |
| TASK-002 | 在 cmd/lake/presentation.go 添加每轮上下文预算、展示工具纠错结果计数和模型包装；第二次失败后禁用工具并请求直接正文，阻止忽略工具关闭的调用。 | Yes | 2026-10-01 |

### Implementation Phase 2

- **GOAL-002**: 验证真实链路并签名安装。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | 添加桥接、工具与模型回归测试：旧报告兼容、A2UI 成功修正、连续失败自动正文、下一轮恢复、已执行工作流仅分析且保留实际指标。依赖 TASK-001、TASK-002。 | Yes | 2026-10-01 |
| TASK-004 | 运行 Go race、前端和浏览器验证；更新 README；使用 scripts/build_lake_desktop.sh --install 签名构建、校验并更新安装目录。依赖 TASK-003。 | Yes | 2026-10-01 |

## 3. Alternatives

- **ALT-001**: 仅延长工具重试提示；模型仍可能重复相同错误，未采用。
- **ALT-002**: 将无效参数视为成功；会隐藏缺失数据，未采用。

## 4. Dependencies

- **DEP-001**: 现有官方 A2UI 渲染器及 automaticReply.ts 自动正文转换。
- **DEP-002**: Lake 模型适配器支持请求级 WithTools(nil)，工具注册器保留纠错反馈。

## 5. Files

- **FILE-001**: cmd/lake/chat.go、workflow_adaptive.go：工具选择及只读分析。
- **FILE-002**: cmd/lake/presentation.go、a2ui.go、visual_report.go：每轮预算及工具反馈。
- **FILE-003**: cmd/lake/presentation_test.go、visual_report_test.go、bridge_test.go、README.md：验证与说明。
- **FILE-004**: client/desktop/frontend/src/App.tsx、shared/ConversationMessages.tsx：移除已不使用的旧报告转换回调。

## 6. Testing

- **TEST-001**: 两次无效展示后模型请求无工具，包含真实结果；下一轮工具恢复。
- **TEST-002**: 成功的第二次展示仍生效；取消及存储错误不计为格式失败；并发调用预算安全。
- **TEST-003**: 工作流实际执行一次，后续分析只公开展示/已存记录读取；自动正文在官方 A2UI 渲染器正确展示。
- **TEST-004**: Go race、桌面前端检查、浏览器验证及应用深度严格签名校验通过。

验证记录：32 项桌面前端测试、2 项 Web 事件测试、Go agent/store/CLI race 与桌面 Go race、go vet 通过。桥接回归使用本地模型及工作流示例执行器验证两次无效布局后关闭工具、保留实际记录、输出完整正文、下一轮恢复 UI；成功纠正和旧报告通道继续通过。Playwright 验证官方 A2UI 正文、CPU/磁盘百分比图表、明细筛选、代码复制、仅填入命令及窄屏；未查询真实主机。

交付记录：已使用 scripts/build_lake_desktop.sh --install 构建并安装；安装目录与构建的桌面、CLI 签名 CodeDirectory 散列一致，嵌入 CLI 与 bin/lake 的代码签名散列一致，深度严格签名检查通过，稳定身份 Lake Local Development Code Signing；builds 只保留 Lake-20261001-172716-29560.app。原安装应用保留备份。

## 7. Risks & Assumptions

- **RISK-001**: 模型忽略关闭工具并仍返回调用；包装器阻断调用并返回明确展示说明，不执行操作。
- **ASSUMPTION-001**: 运行中的安装版已过期，需更新安装位置；用户原会话保存在 ~/.lake，不随应用替换删除。

## 8. Related Specifications / Further Reading

[默认 A2UI 回复](feature-a2ui-default-replies-1.md)
[Lake 构建规则](../AGENTS.md)
