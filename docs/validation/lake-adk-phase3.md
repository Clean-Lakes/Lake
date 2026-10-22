# ADK B 阶段验证记录

- 分支：`experiment/adk-runtime`
- 日期：2026-10-18
- ADK：`google.golang.org/adk/v2 v2.6.0`
- Go：`go 1.26.6`
- 设计说明：`docs/experiments/adk-runtime.md`

## 完成内容

| 项 | 结果 |
|---|---|
| ADK Gate 接管 policy | Gate 调用 Lake policy bridge，决定 risk/target/fingerprint |
| ADK Gate 接管审批 | `RequestConfirmation` → Lake `AIPending` → `Runtime.Resume` |
| ADK Gate 接管证据 | `<DataDir>/adk/<session>/evidence.jsonl`，0600，append-only |
| 批准后执行 | `Engine.InvokeExternalApproved`，不再触发 Lake 二次审批 |
| MCP/workflow/schedule 审批 | 需要审批的 session tools 也走 Gate |
| 驳回 | `TestADKRuntimeWriteRejectionDoesNotExecute` |
| 待审批时中止 | `TestADKRuntimeAbortWhileApprovalPending` |
| 证据内容 | 写审批测试断言 `approval_requested/approved/started/completed` |

## 验证

```bash
go test ./internal/web -run 'TestADKRuntime'
go test ./internal/web
go test ./...
go vet ./...
scripts/build_lake.sh
```

- ADK 集成测试全部通过（真实工具、写审批、驳回、待审批中止、SRE reply、SRE collaborate、图片输入）。
- `internal/web` 全量通过（约 101s）。
- 全量 Go 测试、vet、签名构建需在最终阶段确认。

## 仍未完成

- **C**：SRE coordinator/investigator/executor/verifier 仍在 Lake Go 引擎，未移植成 ADK graph。
- 旧 `Engine.ChatTurn`、`multi_agent.go` 和旧 SRE 编排仍未删除。
- ADK 输出图片的 UI 展示尚未补齐。

## 结论

B 阶段的可运行路径已完成：ADK Gate 拥有 policy、审批和证据；Lake 只执行已批准的工具。C 阶段仍需独立完成 SRE graph 移植，之后才能删除旧 runtime。
