# ADK A 阶段验证记录

- 分支：`experiment/adk-runtime`
- 日期：2026-10-18
- ADK：`google.golang.org/adk/v2 v2.6.0`
- Go：`go 1.26.6`
- 设计说明：`docs/experiments/adk-runtime.md`

## 完成内容

| 项 | 结果 |
|---|---|
| ADK 升级到 v2.6.0 | 完成 |
| Go 升级到 1.26.6 | 完成；`go.mod` 与本地工具链一致 |
| CI Go 版本 | `.github/workflows/tests.yml`、`windows-client.yml` 均为 `1.26.6` |
| ADK 图片输入 | 完成；`TestADKRuntimeAcceptsImageInput` |
| 默认 runtime | 新会话默认 `agentRuntime=adk` |
| Go 回退 | 会话仍可显式选择 `Go（兼容回退）` |
| 测试基线 | `fixture` 显式使用 Go，避免改变既有 Go runtime 测试 |

## 验证

```bash
go test ./...
go vet ./...
scripts/build_lake.sh
```

结果：

- `go test ./...`：全部通过（`internal/web` 约 93s）。
- `go vet ./...`：通过。
- `scripts/build_lake.sh`：成功；`bin/lake` 约 47 MB，链接 ADK v2.6.0 / genai v1.74.0。
- 新增 ADK 集成测试：`TestADKRuntimeAcceptsImageInput`。
- 既有 ADK 测试（真实工具、写审批、中止、SRE reply、SRE collaborate）继续通过。

## 未完成：B/C

- **B**：Lake 工具的 policy/审批/证据仍由 `Engine.invoke` 负责；尚未迁到 ADK-native Gate/插件。
- **C**：SRE coordinator/investigator/executor/verifier 仍在 Lake Go 引擎；尚未移植成 ADK graph。
- 因此 `Engine.ChatTurn`、`multi_agent.go` 和旧 SRE 编排仍未删除；Go runtime 是显式回退路径。

## 结论

A 阶段已完成并保持可回退：默认 ADK、图片输入、ADK/Go/CI 版本对齐。B/C 是独立的风险模型重写，不能在本阶段用“删除旧 runtime”代替。
