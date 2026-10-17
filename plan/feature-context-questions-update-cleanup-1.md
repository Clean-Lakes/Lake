---
goal: Lake 根据上下文适时提问并在成功更新后清理旧包
version: 1
date_created: 2026-10-14
last_updated: 2026-10-14
owner: Lake
status: Completed
tags: [feature, questions, updater]
---
# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

提问由模型依据当前请求、会话和工具证据判断；前端采用逐题选择卡。更新清理由安装成功记录驱动。

## 1. Requirements & Constraints

- **REQ-001**: Prompt 和 ask_user_question 契约描述提问时机：优先自行查证和沿用已确定选择，仅询问会显著改变范围、目标或交付的未知决策。
- **REQ-002**: 支持旧字符串选项及带 label/description/recommended 的选项；分页显示 1/N、多选、其他补充、跳过、返回、关闭和键盘提交；跳过不是拒绝或授权。
- **REQ-003**: macOS 仅在新版准备好后删除本次旧 app 和受限命名、bundle identity/version 验证通过的旧备份；清理完成的下载目录。失败继续回退。
- **REQ-004**: Windows 清理成功任务目录，保留正在运行或失败的安装任务，处理安装助手文件暂时锁定时的重试。
- **SEC-001**: 不扫描或删除用户 Downloads、用户数据、任意 app；拒绝 symlink、越界目录和未知任务文件。
- **CON-001**: 保留已有改动；macOS 用户二进制只用 scripts/build_lake.sh 签名构建。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 提问策略与选择卡一致。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | internal/ai/prompts/question-policy.txt、extended_catalog.go 和 session_tools.go 定义上下文决策策略、结构化选项、跳过响应；catalog.go 校验兼容选项 schema。 | ✅ | 2026-10-14 |
| TASK-002 | web-agent/web/src/AgentQuestion.tsx 和 questionState.ts 实现逐题状态及 UI；shared/contracts.ts 更新契约；新增行为测试。 | ✅ | 2026-10-14 |

### Implementation Phase 2

- **GOAL-002**: 成功后清理，失败保留回退。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | client/macos 的 UpdateCleanup.swift、install-update.sh、Updater.swift 只清理已验证旧备份及已完成任务；构建安装脚本核验新版后清理本次旧 app。 | ✅ | 2026-10-14 |
| TASK-004 | internal/desktopupdate/cleanup.go 及 Windows updater/helper 实现完成标记、精确清理和重试；共享逻辑可在 macOS 单测。 | ✅ | 2026-10-14 |
| TASK-005 | Go 竞态测试、前端测试和类型检查、Swift 策略/清理测试、真实隔离安装器成功与失败场景、浏览器交互；签名构建。 | ✅ | 2026-10-14 |

## 3. Alternatives

- **ALT-001**: 每轮固定问卷会打断明确请求，因此只由模型在决策点调用。
- **ALT-002**: 安装前删除旧 app 会失去回退，禁止采用。

## 4. Dependencies

- **DEP-001**: 现有 QuestionRequest/ReplyQuestion、更新 ready receipt、Swift Foundation、Go platform 私有文件支持。

## 5. Files

- **FILE-001**: internal/ai 的提问契约/提示词，web-agent 的提问组件/状态和测试。
- **FILE-002**: client/macos/Sources/LakeUpdateCore/UpdateCleanup.swift、Updater.swift、Resources/install-update.sh、Tests 及 scripts/test_lake_macos_installer.py。
- **FILE-003**: internal/desktopupdate/cleanup.go 及测试，client/windows/updater_windows.go、update_helper_windows.go。

## 6. Testing

- **TEST-001**: 新旧选项兼容、无默认选择、多选与补充共存、跳过和关闭、已回答不重复询问的模型策略。
- **TEST-002**: macOS 成功清理、安装失败回退、未知文件/未来版本/符号链接不删除。
- **TEST-003**: Windows 完成目录清理和未完成任务保护；macOS 上验证共享逻辑，Windows 原生运行范围如实报告。

## 7. Risks & Assumptions

- **RISK-001**: 提问是否适时取决于所选模型对上下文的判断，工具本身不强制每轮提问。
- **ASSUMPTION-001**: 旧包指 Lake 自身管理的安装备份和更新缓存；用户下载目录及仓库发布归档不属于自动清理范围。

## 8. Related Specifications / Further Reading

[Agent 工具](feature-agent-tools-1.md)
[macOS 客户端](../client/macos/README.md)
