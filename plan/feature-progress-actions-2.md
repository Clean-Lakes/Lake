---
goal: Lake 所有内置工具显示具体动作、目标和实际状态
version: 2
date_created: 2026-10-01
last_updated: 2026-10-01
owner: Lake
status: Completed
tags: [feature, progress, desktop, web]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

扩展已有进度行，使用共享动作目录覆盖阅读、搜索、编辑、新建、删除、恢复、代码状态、命令、浏览器、脚本和工作流操作。所有状态依据实际事件；保留具体文件或目标。

## 1. Requirements & Constraints

- **REQ-001**: 每个内置工具有明确动作名称；专员内的文件与命令操作同样展示。
- **REQ-002**: 多文件 patch 区分修改、删除和混合操作；远程写入使用 absent 前置条件区分新建与编辑。
- **REQ-003**: 进行中、完成、失败、取消、未知均保留具体动作；连续编辑等操作可汇总并展开逐项状态。
- **SEC-001**: 仅输出白名单路径、查询词、任务标识和命令摘要；不输出文件内容、SQL或任意参数。
- **CON-001**: 保持 Go/Eino 运行时、现有权限流程和专员卡片，macOS 使用签名构建脚本。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 为桌面和 Web 提供一致的动作目录及动态动作信息。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | 新增 cmd/lake/activity_tools.json；activity.go 使用 embed 读取目录并提取具体动作和目标；bridge.go 保存 activity_kind、activity_action、activity_count；store/agent_event.go 允许受限字段。 | ✅ | 2026-10-01 |
| TASK-002 | activity.ts 读取共享目录及事件动作，完善未知工具提示和相邻文件变更归组；ActivityLine.tsx 增加对应图标。依赖 TASK-001。 | ✅ | 2026-10-01 |

### Implementation Phase 2

- **GOAL-002**: 验证专员文件操作实际传递到会话并交付签名应用。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | activity_test.go 验证白名单、patch/remote 动作及代码专员读取、新建、编辑、删除的桥事件；activity.test.mjs 验证目录覆盖、各类状态和归组。依赖 TASK-002。 | ✅ | 2026-10-01 |
| TASK-004 | 运行 cmd/lake 与相关 store 测试、前端测试、桌面/Web 构建；使用 scripts/build_lake_desktop.sh --install 安装签名版本，实际窗口验证。依赖 TASK-003。 | ✅ | 2026-10-01 |

## 3. Alternatives

- **ALT-001**: 由模型编写操作状态无法保证真实结果，改用工具动作目录和真实事件。
- **ALT-002**: 分别维护 Go 和 TypeScript 动作目录会遗漏新增工具，使用同一个 JSON 目录并测试源代码中的内置工具名称覆盖。

## 4. Dependencies

- **DEP-001**: 既有 tool_proposed/tool_finished 事件和 Go embed、TypeScript JSON 模块。
- **DEP-002**: 既有专员内部事件透传及 ActivityLine 组件。

## 5. Files

- **FILE-001**: cmd/lake/activity_tools.json、activity.go、activity_test.go、bridge.go；lake/store/agent_event.go；scripts/build_lake_desktop.sh 保留 staging 中目录位置以复制共享目录。
- **FILE-002**: client/desktop/frontend/src/activity.ts、activity.test.mjs、shared/ActivityLine.tsx、client/desktop/README.md。

## 6. Testing

- **TEST-001**: 白名单摘要与动态动作正确，不包含变更内容或凭据。
- **TEST-002**: 真实 Eino 代码专员调用在临时项目完成读取、新建、编辑和删除；桥事件与持久事件一致，文件实际结果验证。
- **TEST-003**: 内置工具目录完整、状态文本准确、归组保留各类文件操作；前端/Web 构建及签名验证通过。
- **TEST-004**: 实际 Lake 会话显示列出、搜索、读取、保存检查点、编辑和创建的进度，结束后及重开后保留状态；展开显示 sample.txt/new.txt 的逐项完成记录。独立目录不是 Git 仓库，状态和差异查询正确显示失败；实际文件内容核对通过。验证记录位于 `~/Library/Application Support/Lake/test-reports/progress-actions-20261001/verification.json`，同目录保存运行和完成截图。

## 7. Risks & Assumptions

- **RISK-001**: Shell 命令可包含任意行为，使用真实命令摘要，不根据命令猜测文件变更成功。
- **ASSUMPTION-001**: 旧历史事件没有动态动作元数据时使用目录中的保守动作名称。

## 8. Related Specifications / Further Reading

[已有进度行方案](feature-progress-lines-1.md)
[桌面说明](../client/desktop/README.md)
