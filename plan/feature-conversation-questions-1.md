---
goal: 会话内结构化澄清与同轮继续执行
version: 1.0
date_created: 2026-10-01
last_updated: 2026-10-01
owner: Lake
status: 'Completed'
tags: [feature, conversation, desktop]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-green)

将目标、配置或偏好不明确的澄清接入 Agent 工具与桌面会话。回答作为当前工具结果继续同一次 Runner 执行，不创建新轮次；保留问题与回答供会话回看。

## 1. Requirements & Constraints

- **REQ-001**: lake_ask_user 接受 1–3 个带独立 ID 的问题，每题支持 0 或 2–3 个选项及自由文本；回答必须完整且与待回答请求匹配。
- **REQ-002**: 桌面展示会话内问题卡，回答后继续当前运行，不发送新的 ask；单题允许通过主输入框回答。
- **REQ-003**: 问题和回答进入有界、校验的会话事件；历史问题不可提交，后续轮次及重启后保留已回答的澄清上下文。
- **SEC-001**: 澄清不是执行授权；审批工具及 SSH 权限保持现有判断。问题工具不接受或索取凭据。
- **CON-001**: 人工等待只受运行上下文取消控制，不触发普通工具 90 秒超时；其他工具时限不变。
- **PAT-001**: 复用 Go/Eino、JSON Lines 桥及现有 React 会话时间线；签名构建使用 scripts/build_lake_desktop.sh。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 同轮工具与桥支持结构化请求和严格回答匹配。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | lake/agent/user_input.go 定义问题/回答及长度、ID、选项和敏感内容验证；cmd/lake/user_question.go 实现工具及终端提问，chat.go 注册工具与澄清指令，tool_registry.go 和 lake/agent/tools/registry.go 对 user_input 能力使用取消控制。 | ✅ | 2026-10-01 |
| TASK-002 | cmd/lake/bridge_question.go 实现按 turn ID 和问题请求 ID 匹配的串行问题门；bridge.go 新增 question/question_answer/close 处理及事件记录；agent_event.go 增加校验字段，chat.go 恢复澄清上下文。依赖 TASK-001。 | ✅ | 2026-10-01 |

### Implementation Phase 2

- **GOAL-002**: 桌面实时及历史问题可用，错误回答不终止运行。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | client/desktop/app.go 与 frontend/src/wails.d.ts 增加 AnswerQuestion；frontend/src/shared/QuestionCard.tsx、userQuestions.ts、timeline.ts 和 App.tsx 显示选项、自由回答、已回答与中断状态，单题主输入框向当前工具回答。依赖 TASK-002。 | ✅ | 2026-10-01 |
| TASK-004 | cmd/lake/user_question_test.go 与 bridge_question_test.go 验证模型提问→用户回答→同一运行继续，过期/重复/缺失回答、取消、持久化与重启上下文；前端回归时间线及提交状态，运行受影响 Go 测试/vet、前端构建和签名桌面原生验证。更新 docs/migration-closure.md。依赖 TASK-001 至 TASK-003。 | ✅ | 2026-10-01 |

## 3. Alternatives

- **ALT-001**: 在最终回复中列问题再发新轮次无法保留本轮工具执行上下文，采用当前工具等待和回传。

## 4. Dependencies

- **DEP-001**: 现有 Eino ADK 工具执行、会话事件存储、Wails 桥接及签名脚本。

## 5. Files

- **FILE-001**: lake/agent/user_input.go、lake/agent/tools/registry.go、cmd/lake/user_question.go：问题合同及工具。
- **FILE-002**: cmd/lake/bridge_question.go、bridge.go、chat.go、lake/store/agent_event.go：桥、持久事件与上下文。
- **FILE-003**: client/desktop/app.go、frontend/src/shared/QuestionCard.tsx、userQuestions.ts、timeline.ts、App.tsx：桌面呈现与回答。

## 6. Testing

- **TEST-001**: 问题及回答字段完整、长度有界、ID 唯一；错误和过期回答不解除等待。
- **TEST-002**: 模拟模型发起问题并检查回答工具结果；同一 turn ID 只有一次最终结果，下一轮和重启保留澄清上下文。
- **TEST-003**: user_input 没有工具附加超时，取消或关闭桥可结束等待；普通工具仍有时限。
- **TEST-004**: 桌面问题选项、自由回答、历史恢复、失败重试及主输入框单题回答；签名构建可实际使用。

2026-10-01 验收结果：

- `go test ./cmd/lake ./lake/...`、`go vet ./cmd/lake ./lake/...` 通过；桌面模块 `go test ./...` 与 `go vet ./...` 通过。
- `go test ./cmd/lake ./lake/agent/... -race -run 'Question|UserInput|TerminalQuestions' -count=1 -timeout=45s` 通过；模型/桥集成用例验证同一 turn ID 继续及重启后的澄清上下文。
- 前端 `npm test` 六项测试与 `npm run build` 通过。
- `scripts/build_lake_desktop.sh` 生成 `~/Library/Application Support/Lake/builds/Lake-20261001-100203-82966.app`；CLI 与 app 的严格代码签名验证通过。
- 原生桌面使用已登记模型验证：两题卡选择蓝色并填写 Markdown 后，同轮回复确认；单题在主输入框发送绿色后，同轮回复确认。等待期间无最终回复，回答后卡片显示已收到，完成后主输入恢复可用。全程未查询资源或执行远端操作。

## 7. Risks & Assumptions

- **RISK-001**: 重复点击或迟到回答不得匹配下一次问题；需同时验证运行 ID 和问题请求 ID。
- **RISK-002**: 应用退出后原运行上下文已结束；历史未回答问题仅显示中断状态，不能提交给新运行。
- **ASSUMPTION-001**: 用户要求改造交互；截图中的 nginx 指令只用于说明，未授权本次执行远端修改。

## 8. Related Specifications / Further Reading

[四项迁移闭环](feature-migration-closure-1.md)

[使用说明](../docs/migration-closure.md)
