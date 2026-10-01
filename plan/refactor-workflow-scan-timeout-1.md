---
goal: 修复文件系统巡检扫描步骤被固定20秒超时切断及完成数误导
version: 1.0
date_created: 2026-10-01
last_updated: 2026-10-01
owner: Lake
status: 'Completed'
tags: [bug, workflow, ssh, ui]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-green)

本地运行记录 9b9750e4-cc76-4acd-aa66-1f564d779f02 证实：9项巡检中7项成功，du/find 两项约20秒超时，远端退出状态未知。运行定义缺少独立SSH执行时间配置，界面把终止步骤数显示成完成数。

## 1. Requirements & Constraints

- **REQ-001**: v1工作流步骤支持 timeout_seconds，0沿用现有20秒默认，1–3600秒可配置；SSH建立连接仍保持现有期限，父上下文取消或更短期限优先。
- **REQ-002**: 对测试湖文件系统状态检查的 top_dirs 和 large_files 配置300秒，并使后者在前者成功结束后运行，避免并行全盘扫描；不自动执行巡检，不改动历史运行快照。
- **REQ-003**: 界面按真实 completed 步骤计成功数，unknown/failed/skipped/cancelled不能算成功；超时结果未知使用简明中文，原错误保留于摘要下载和提示。
- **SEC-001**: 结果未知仍不得自动重放；主机校验、授权、凭据文件和审计机制保持原有行为，不读取Keychain或输出凭据。
- **CON-001**: 配置变更前备份原工作流JSON；只通过签名脚本构建和安装应用。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 独立SSH执行时间配置在真实传输层生效，保持原有取消与重放规则。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | 在 lake/transport/ssh/client.go 增加 WithCommandTimeout 和命令执行期限读取，连接建立不使用该值；在 lake/workflow/timeout_test.go 通过本地SSH服务器验证较长命令、较短父期限和无重复派发。 | Yes | 2026-10-01 |
| TASK-002 | 在 lake/workflow/spec.go 添加 TimeoutSeconds 字段并校验范围；engine.go 每个步骤单独传递执行期限，在 timeout_test.go 验证配置快照与实际传输效果，依赖TASK-001。 | Yes | 2026-10-01 |

### Implementation Phase 2

- **GOAL-002**: 准确展示7项成功与2项未知，并更新未来巡检配置。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | 新建 workflowTrace.ts 计算真实成功数及简明超时文案，在 SpecialistCallCard.tsx 使用；添加输入7项完成2项未知及历史缺少步骤详情的语义测试。 | Yes | 2026-10-01 |
| TASK-004 | 备份当前工作流JSON，用签名CLI更新两项 timeout_seconds=300，large_files依赖top_dirs且when=all_success；验证历史未变。更新README和工具说明。依赖TASK-002。 | Yes | 2026-10-01 |
| TASK-005 | 运行相关Go/race、前端语义测试与生产构建；先构建Web资源，再签名打包安装；确认会话空闲，保留输入与侧栏宽度后重启并检查历史失败卡片。依赖TASK-003、TASK-004。 | Yes | 2026-10-01 |

## 3. Alternatives

- **ALT-001**: 统一提高所有SSH连接与命令超时，会改变普通命令和握手行为，不采用。
- **ALT-002**: 超时后直接重试扫描，会重放远端结果未知的命令，不采用。

## 4. Dependencies

- **DEP-001**: 现有工作流DAG快照和SSH上下文传递；现有签名构建脚本。
- **DEP-002**: 本地只读运行记录及工作流 493ba4f8-78f2-4c64-b7b8-7d59b4d81bf9 的保存配置。

## 5. Files

- **FILE-001**: lake/transport/ssh/client.go；lake/workflow/spec.go、engine.go、timeout_test.go。
- **FILE-002**: client/desktop/frontend/src/workflowTrace.ts、workflowTrace.test.mjs、SpecialistCallCard.tsx、App.css；client/desktop/frontend/package.json；cmd/lake/workflow_tools.go；README.md；本计划。
- **FILE-003**: ~/.lake/backups/workflow-filesystem-timeout-20261001 下的原配置及更新配置JSON。

## 6. Testing

- **TEST-001**: 本地SSH测试服务器在原执行期限后返回结果，覆盖显式较长期限、父期限取消、普通命令默认期限及单次派发。
- **TEST-002**: 工作流范围校验、运行快照保留timeout_seconds、引擎向SSH执行器传播配置。
- **TEST-003**: 7项completed+2项unknown显示部分完成7/9；历史仅有终止计数时不得声称全部成功；超时文案保留结果未知含义。
- **TEST-004**: 真实历史卡片显示成功计数和简明超时原因；工作流配置更新且原运行快照不变；已安装签名应用包含最新Web资源。

验证结果（2026-10-01）：

- `go test -race ./lake/transport/ssh ./lake/workflow ./lake/operate ./cmd/lake` 和 `go vet ./lake/transport/ssh ./lake/workflow ./cmd/lake` 通过。
- 前端37项测试通过，Web与桌面生产构建通过。浏览器中的真实卡片组件在220、320、480、680像素宽度均无状态栏溢出；两项未知保留完整错误提示。
- 签名CLI已更新保存定义，两项300秒、大文件扫描依赖目录扫描成功；4份历史运行快照哈希未变，没有新建远端巡检运行。原始和更新配置已保存于上述备份目录。
- `scripts/build_lake_desktop.sh --install` 安装 `Lake-20261001-184822-37734.app`；严格签名校验通过。CLI与安装应用包含当前Web资源 `index-CM_XG-82.js` 和 `index-Bw3a6ZkV.css`。
- 空闲时重启已安装应用，侧栏335像素和空输入框保持；真实历史卡片显示“部分完成7/9 · 2项结果未知”和两条简明超时原因。截图：`/Users/lingyunxieqing/.codex/visualizations/2026/10/01/01a0f56d-49ee-7c22-9f04-58470bd48b44/lake-filesystem-timeout-fix.png`。临时测试页面与开发服务已清理。

## 7. Risks & Assumptions

- **RISK-001**: 扫描仍可能超过300秒；延长期限解决固定20秒问题，不保证远端负载下必然成功。
- **ASSUMPTION-001**: 用户要求修复巡检失败，授权更新该工作流未来执行配置；本次不派发新SSH扫描。

## 8. Related Specifications / Further Reading

[工作流定义](../lake/workflow/spec.go)
[SSH传输](../lake/transport/ssh/client.go)
[构建规则](../AGENTS.md)
