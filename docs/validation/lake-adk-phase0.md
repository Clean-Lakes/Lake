# ADK Phase 0 验证记录

- 分支：`experiment/adk-runtime`
- 日期：2026-10-17
- ADK 版本：`google.golang.org/adk/v2 v2.0.0`
- Go 版本：`go 1.25.0`（本地工具链 `go1.25.4`）
- 设计说明：`docs/experiments/adk-runtime.md`

## 门禁结果

| 门禁 | 结果 | 证据 |
|---|---|---|
| Lake provider 经自定义 model adapter 流式输出和工具调用 | 通过 | `TestLakeLLMNonStreaming`、`TestLakeLLMStreamingYieldsPartialsAndFinal`、`TestLakeRequestConvertsToolHistory` |
| ADK HITL 暂停/恢复，进程重启后可继续 | 通过 | `TestRuntimePausesForApprovalAndResumes`、`TestRuntimeResumeAfterSQLiteReload`；CLI 两次进程完成审批 |
| 写工具不能绕过 Gate 和审批 token | 通过 | `TestGateWriteRequiresApprovalAndDoesNotExecute`、`TestGateApprovedCallExecutesOnce`、`TestGateRejectsChangedArguments`、`TestGateRejectsMissingAndWrongToken`、`TestGateRejectedConfirmationDoesNotExecute` |
| 每次调用/结果写 append-only 证据，且不泄露凭据 | 通过 | `TestFileEvidenceIsAppendOnly`、`TestGateRedactsCredentialArguments`、`TestEvidenceRedactsToolResult`；CLI 生成 JSONL 证据 |
| 只读工具不弹审批 | 通过 | `TestGateReadOnlyExecutesWithoutApproval`、`TestRuntimeReadOnlyToolExecutesWithoutApproval` |
| 现有 Go 测试无新增失败 | 通过 | `go test ./...` 全部通过 |

## 执行的命令

```bash
go build ./...
go vet ./internal/agent/adk ./cmd/adk-spike
go test ./internal/agent/adk
go test ./internal/ai
go test ./internal/extensions
go test ./internal/web
go test ./...
scripts/build_lake.sh
```

结果：

- `go build ./...`：通过。
- `go vet ./internal/agent/adk ./cmd/adk-spike`：通过。
- `internal/agent/adk`：17 个测试全部通过（含 `-race`）。
- `internal/ai`：通过（约 16s）。
- `internal/extensions`：通过。
- `internal/web`：通过（约 87s）。
- `go test ./...`：全部通过；`cmd/adk-spike` 无测试文件。
- `scripts/build_lake.sh`：成功生成签名后的 `bin/lake`；仅有既有的 Node engine 警告（项目要求 Node 24，当前环境 Node 22）。

## CLI 验证

只读脚本模型：

```bash
go run ./cmd/adk-spike --scripted --data <tmp> --message "check host"
```

实际结果：`inspect_host` 返回 `uname`、`uptime`、`df -h`，随后模型输出总结，`[done]`。

写操作审批：

1. 首次运行 `--scripted-write`，Gate 生成 `approval_id`，ADK 发出 `adk_request_confirmation`；工具返回 `approval_required`，未执行。
2. 拒绝时 token 被消费，后续重放失败。
3. 用首次运行打印的 `confirmation id` + `payload` 在**新进程**中执行 `--approve`，Gate 校验通过并执行 `touch /tmp/lake-adk-spike`。
4. 证据 JSONL 依次出现 `approval_requested`、`approved`、`started`、`completed`。

证据文件权限为 0600，审批文件权限为 0600；证据中的参数经过 key 和 `password=`/`Bearer` 模式脱敏。

## 未覆盖

- 还没有把替身工具接到 Lake 真实资源/SSH/终端执行层。
- 还没有 Web UI、每会话 runtime 切换、完整工具目录、MCP、Skills、项目记忆、context compaction。
- 还没有 SRE graph、验证 gate、旧 runtime 删除和默认切换。
- Windows 未实测；ADK v2.6.0 需要 Go 1.26.6，当前仍固定在 v2.0.0。

## 结论

Phase 0 的四个硬门禁全部通过：ADK Go 2.0 可以作为 Lake 的 runtime 候选；统一 Gate + 一次性审批 token + append-only 证据的组合能阻止写操作绕过。下一步进入 Phase 1，但仍不切换默认 runtime。
