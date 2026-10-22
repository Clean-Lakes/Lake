# ADK Phase 1 验证记录

- 分支：`experiment/adk-runtime`
- 日期：2026-10-17
- ADK：`google.golang.org/adk/v2 v2.6.0`
- Go：`go 1.26.6`
- 设计说明：`docs/experiments/adk-runtime.md`
- Phase 0 记录：`docs/validation/lake-adk-phase0.md`

## 已验证

| 能力 | 结果 | 测试 |
|---|---|---|
| ADK runtime 真实调用 Lake 工具 | 通过 | `TestADKRuntimeUsesLakeToolsAndCards` |
| 写操作走 Lake 现有审批，未批准不执行 | 通过 | `TestADKRuntimeWriteUsesLakeApproval` |
| 中止 ADK turn 并停止待回答的问题 | 通过 | `TestADKRuntimeAbortStopsPendingQuestion` |
| SRE coordination catalog/prompt | 通过 | `TestADKRuntimeSRECatalogUsesCoordinationTools` |
| `sre_reply` 正式答复回填 | 通过 | `TestADKRuntimeSREReplyUsesFormalText` |
| `sre_collaborate` 交接给 Lake SRE 引擎 | 通过 | `TestADKRuntimeSRECollaborateHandsOffToLakeEngine` |
| ADK 图片输入 | 通过 | `TestADKRuntimeAcceptsImageInput` |
| 默认 runtime 切到 ADK、Go 可显式回退 | 通过 | `agentRuntimeDefault` + `fixture` Go 基线 |
| 每会话 `agentRuntime` 选项 | 通过 | `configure` 校验 + 上述集成测试 |
| 受控默认 `LAKE_ADK_DEFAULT` | 通过 | `sessionOptions` 仅在无显式值时覆盖 |
| 默认 runtime 不变 | 通过 | 未设置 flag 时 `agentRuntime=go` |

## 集成行为

1. 会话选择 `agentRuntime=adk` 后，`runTurn` 不再调用 `Engine.ChatTurn`，改为 `runADKTurn`。
2. `LakeLLM` 复用 Lake 当前模型/provider/key，ADK 不引入第二套模型配置。
3. `Engine.CatalogForSession` 把 Lake 的当前工具目录转成 ADK function tools。
4. 每次工具调用进入 `Engine.InvokeExternal`，继续走 Lake 的 policy、审批、终端/数据库执行和 operation 记录。
5. ADK 文本事件映射到 Lake `message` 卡片；final 文本写入 `messages` 表；错误映射为 `error` 卡片。
6. 写操作等待 Lake `AIPending`；批准后由 Lake 执行，ADK 只拿到工具结果。
7. Abort 取消 ADK run context；`runADKTurn` 检测 `runCtx.Err()` 并以 `cancelled` 结束。
8. SRE 项目保留 coordination prompt/catalog；`sre_reply` 回填正式文本，`sre_collaborate` 交接给现有 Lake SRE 引擎。

## 命令与结果

```bash
go test ./internal/agent/adk
go test ./internal/ai
go test ./internal/web
go test ./...
go vet ./...
scripts/build_lake.sh
```

- `internal/agent/adk`：Phase 0 的 17 个测试通过（含 `-race`）。
- `internal/ai`：通过。
- `internal/web`：通过（包含上述 6 个 ADK 集成测试）。
- `go test ./...`：通过。
- `go vet ./...`：通过。
- `scripts/build_lake.sh`：成功生成签名后的 `bin/lake`；本地体积约 47 MB，已链接 ADK v2.0.0。

## Runtime

- 新会话默认 `agentRuntime=adk`。
- 会话配置仍可选择 `Go（兼容回退）`；显式 `go` 不受默认值影响。
- 默认 ADK 仍复用 Lake 的模型/provider/key 和工具审批路径。

## 未完成

- B：Lake 工具的 policy/审批/证据仍由 `Engine.invoke` 负责，没有改成 ADK-native 插件。
- C：SRE coordinator/investigator/executor/verifier 仍在 Lake Go 引擎，未移植成 ADK graph。
- 旧 `Engine.ChatTurn`、`multi_agent.go` 和旧 SRE 编排尚未删除；需要 B/C 验收后再删。
- ADK 图片输入已支持；模型输出图片和多模态展示仍待完善。

## 结论

Phase 1 已把 ADK 接入 Lake 的会话、工具、审批、卡片、中止和 SRE 交接路径，并且默认行为保持 Go。下一阶段的关键不是再接一层，而是决定是否承担 ADK-native SRE graph/cutover 的重写成本。
