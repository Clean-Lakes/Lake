# ADK runtime 接入现状与完整迁移方案

- 分支：`experiment/adk-runtime`
- 日期：2026-10-18
- ADK 版本：`google.golang.org/adk/v2 v2.6.0`
- Go：`1.26.6`
- 状态：A/B 完成，C0 完成——ADK 是默认 runtime，ADK Gate 接管审批/证据；SRE 域已抽出 `SREHost` 接口，C1/C2 的 ADK graph 尚未完成。

后续实施以 [官方 ADK 全量迁移方案](../../plan/refactor-adk-official-runtime-1.md) 为准。该方案替代旧阶段的后续安排，覆盖普通会话兼容、真实 SRE Agent/workflow、审批与进程重启恢复、历史迁移、stdio/工作流入口和旧 runtime 删除。当前仍是接入完成、全量替换未完成；阶段验收记录保留各自执行时的语境。

2026-10-18 已重新执行官方固定版本安装/下载与 `go mod verify`，并通过现有 ADK adapter/gate/runtime/web 集成的选择性 race 回归；范围与命令见 [官方依赖基线](../validation/lake-adk-official-baseline.json)。此结果不代表尚未实现的 SRE workflow 已通过验收。

## 目标

把 Google ADK Go 2.0 作为 Lake 的 agent runtime，同时保留 Lake 的 SRE 工具、policy、审批、终端、证据和 UI。

Phase 0 验证了 ADK 能安全地驱动模型、工具和 HITL；Phase 1 把 ADK 真正接进 `internal/web`：

- `agentRuntime=adk`（默认）的会话由 ADK `LlmAgent`/runner 驱动。
- 模型通过自定义 `LakeLLM` 复用 Lake 现有 provider、key、headers、流式协议和图片输入。
- 工具不再使用 Phase 0 的替身，而是由 Gate 审查后走 `Engine.InvokeExternalApproved`，复用 Lake 的真实工具目录、终端、数据库和操作记录。
- 事件映射到 Lake 的 `message`/`operation`/`error` 卡片和现有 SSE 刷新。
- 工具审批已迁到 ADK Gate：`lakeadk.Gate` 做 policy → confirmation → execute → append-only evidence；批准后的执行走 `Engine.InvokeExternalApproved`，不再触发 Lake 的第二套审批。
- SRE 项目使用 Lake 的 coordination prompt/catalog：`sre_reply` 的正式答复回填到消息卡片，`sre_collaborate` 交接给 Lake 现有 SRE 引擎执行和验证。
- 默认 runtime 是 ADK；Go 保留为会话级回退。

## Runtime 选择

A 阶段已经完成默认 cutover：新会话默认 `agentRuntime=adk`，Go 仍可在会话配置里显式选择，作为回退路径。

```text
Agent runtime: ADK（默认）
Agent runtime: Go（兼容回退）
```

已有显式 `agentRuntime=go` 的会话不会被默认值改写。

当前会话配置下拉仍显示以下旧标签，与后端默认值不一致；修正和最终移除选择器已列入新方案：

- `Agent runtime: Go（默认）`
- `Agent runtime: ADK（实验）`

也可以通过 API 设置：

```bash
curl -X POST .../api/sessions/<id>/ai/configure \
  -H 'Content-Type: application/json' \
  -d '{"agentRuntime":"adk"}'
```

当前后端没有读取 `LAKE_ADK_DEFAULT`；默认值由 `internal/web/agent.go` 和 `server.go` 决定，已保存的显式会话选项优先。

## 架构

```
Lake React Workbench
  └─ /api/sessions/:id/*
Lake Go 宿主（internal/web）
  ├─ 会话、消息、SSE、审批、SRE、终端、资源
  ├─ ADK runtime host（internal/web/adk_runtime.go）
  │    ├─ LakeLLM（internal/agent/adk/model.go）
  │    ├─ Engine.CatalogForSession → ADK function tools
  │    ├─ Gate → Engine.InvokeExternalApproved → 现有工具/终端执行
  │    ├─ ExternalTurn → Lake cards/status/events
  │    └─ ADK session SQLite（<DataDir>/adk/sessions.sqlite，文件 0600 / 目录 0700）
  └─ Go runtime（Engine.ChatTurn，显式会话回退；SRE 专员仍使用）
```

### 工具执行与审批

ADK 会话的每个工具都经过 `lakeadk.Gate`：

- **policy**：Gate 调用 Lake 的 policy bridge 得到 risk/target/fingerprint，再结合会话权限决定是否要审批。
- **approval**：写操作通过 ADK `RequestConfirmation` 暂停；`webADKSink` 把它映射成 Lake 的 `AIPending`；用户决定后 `Runtime.Resume` 恢复。
- **execution**：批准后调用 `Engine.InvokeExternalApproved`，复用 Lake 的工具目录、目标范围、终端和低层执行原语，但跳过 Lake 的第二套交互审批。
- **evidence**：Gate 写入 `<DataDir>/adk/<session>/evidence.jsonl`（0600，append-only）；驳回/取消/参数被篡改都不会执行。
- **session tools**：MCP、workflow、schedule 等需要审批的路径也由 Gate 接管；`Engine.invoke` 只负责执行。
- ADK 的 function tool 只负责参数 schema 和调用桥接。

### 事件映射

`internal/web/adk_runtime.go` 的 `webADKSink`：

- ADK 文本 delta/final → 一个 `message` 卡片；final 文本写入 `messages` 表。
- ADK tool call/result 不重复建卡：Lake 的 `invoke` 已创建 operation 卡片。
- ADK 错误 → `error` 卡片。
- 取消 → AI View 进入 `cancelled` 并清理 pending；外层 Store 在 `finishADKRun` 中仍可能写为 `completed`，统一状态修正列入新方案。
- 审批 → ADK `RequestConfirmation` 经 `View.Pending`/`AIPending` 展示，决策通过 `Runtime.Resume` 恢复；当前 Web 的运行中句柄和单 pending 槽仍需补齐多分支及进程重启恢复。

### SRE

`agentRuntime=adk` 且项目启用 SRE 时：

- `runADKTurn` 临时打开 `sreCoordinator`，使用 Lake 的 SRE coordination prompt 和 catalog。
- `sre_reply` 的正式文本通过 `ApplyExternalSREReply` 回填到消息卡片。
- `sre_collaborate` 仍只准备 handoff；ADK turn 结束后调用现有 `followSREHandoff`，由 Lake 的 coordinator/investigator/executor/verifier 执行计划、审批和验证。
- SRE 的验证、证据、unknown-result 不重放等语义保持在 Lake Go 引擎中。

## Phase 0 独立 CLI

`cmd/adk-spike` 仍保留，用于不启动 Lake Web 的情况下验证：

```bash
go run ./cmd/adk-spike --scripted --data /tmp/lake-adk-spike --message "check the host"
go run ./cmd/adk-spike --scripted-write --data /tmp/lake-adk-spike --message "run a write probe"
```

它使用 Phase 0 的 `Gate`（policy → approval → execute → append-only evidence）和本地替身工具；与集成后的 Lake runtime 不是同一条路径。

## 已完成

- 自定义 `model.Model`，复用 Lake provider 的流式输出、工具调用和 usage。
- ADK session/event 持久化 SQLite；支持同一会话多轮。
- 真实 Lake 工具调用、operation 卡片、审批、写文件、取消。
- SRE coordination prompt/catalog、`sre_reply` 正式答复、`sre_collaborate` 交接。
- 每会话 `agentRuntime` 选项与 ADK 后端默认值。
- Phase 0 的 Gate、一次性审批 token、append-only 证据和独立 CLI。

## 剩余工作（历史阶段对应关系）

具体任务、依赖和门禁以新方案为准，以下仅保留 C 阶段对应关系；对照运行仅用于本地 fixture，不在线双跑真实操作。

1. **C0（已完成）**：`internal/ai/sre_host.go` 抽出 `SREHost`，覆盖 plan、role、verification 和 repository；Engine 实现该接口，行为不变。
2. **C1（未完成）**：新建 ADK graph 只读纵向切片（coordinator → investigator → verifier），在隔离 fixture 中与现有 Go SRE 对比。
3. **C2（未完成）**：executor/审批/验证/暂停恢复对齐，ADK graph 成为 SRE 唯一执行路径。
4. **C3（未完成）**：删除 `Engine.ChatTurn`、`multi_agent.go`、旧 SRE 编排和 Go 回退。
5. **ADK 输出图片**：输入图片已支持；模型输出图片的展示仍待完善。
6. **会话与入口兼容**：图片输入已经支持，不再回退 Go；仍需补齐上下文/历史操作、stdio、保存工作流与调度入口以及旧会话迁移。
7. **二进制体积**：历史构建记录约 47 MB；本轮未重新构建，最终交付前需重新测量签名体积和启动开销。

## 测试

```bash
go test ./internal/agent/adk
go test ./internal/ai
go test ./internal/web
go test ./...
go vet ./...
scripts/build_lake.sh
```

结果见 `docs/validation/lake-adk-phase0.md` 和 `docs/validation/lake-adk-phase1.md`。
