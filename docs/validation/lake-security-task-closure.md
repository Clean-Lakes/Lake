# Lake Security 任务闭环实施记录

日期：2026-11-02。分支：`codex/security-task-closure`。本文记录正在集成的后端实现；最终 tested SHA、签名 Dev、完整回归和合并状态在验收完成后追加。历史 v0.3.24 或基础批次的测试不代表本轮验证通过。

## 五模块与代码

| 模块 | 本轮实现位置 | 边界 |
| --- | --- | --- |
| 任务中心 | `internal/ai/security_intent.go`、`security_runtime.go`、`security_tasks.go`、`security_workflow.go`、`security_sre.go` | WorkGoal/步骤/尝试与限时 SecurityTask 分开；同目标续接保留原绝对期限；子作用域使用自己的规范步骤和尝试 |
| SOP 手册 | 原独立 SOP 设计与计划 | 不改 SOP UI，不把 Items 当任务中心 |
| 安全控制 | `internal/security/`；AI 的 `security_policy/coordinator/catalog/confirmation/mode*.go` | 硬边界优先；项目允许、任务授权、精确单次审批分别验证；旧审批不能跨任务、轮次或恢复 epoch 复用 |
| 资源操作 | `security_execution.go`、`security_files.go`、`security_read_adapters.go`、`security_shell.go`、`security_ssh.go`、Web 的 `security_terminal.go` | 实际 I/O 重验许可；冻结配置与受控命令；不支持的限制降为 opaque 或拒绝，不宣称通用 OS 沙箱 |
| 任务档案与验收 | `work_closure*.go`、`work_manual_acceptance.go`、`execution_ownership.go`、`orphan_reconciler.go`、`security_recovery*.go` | 沿用原操作/审批/证据账本；记录版本化验收、等价覆盖与未决风险，不由另一个任务成功清除 |

## 已执行的验证

以下为集成期间的实际结果，尚未全部固定到最终提交。

| 检查 | 结果 |
| --- | --- |
| 纯安全内核全部测试 | 通过；93 工具注册、授权公式、硬拒绝、精确来源、scope、预算和验收逻辑 |
| Evaluate 性能 | 100 资源、20 规则、20 grants、并发 8；本机非 race 样本 p95 **62µs**；不等于存储派发耗时 |
| 全仓编译 | `go test ./... -run '^$'` 通过 |
| 首轮相关完整 Go 回归 | Web 238.410s、CLI、security 通过；AI 发现工具目录 golden 与循环父子测试夹具问题，均已针对修复，最终完整复跑待记录 |
| 前端兼容 | 原源码类型检查通过，556 项原前端测试全部通过；没有修改 shared 契约或前端代码 |
| Memory 与恢复专项 race | 通过；含真实 reopen/prepareHTTPServer、原同意与遗忘保留、无 Memory schema 的只读查看；Memory 内部权威未更换 |
| 后台/SSH/并行专项 race | 通过；真实本地进程取消、SSH 握手与固定 argv、断链未知、原事件同任务续接、共享预算与并行独立步骤 |
| 终端/授权专项 race | 已有专项通过；最终原提问→原审批→签约→重新准备→I/O 的完整调用链继续集成 |
| 静态检查 | ADK runtime boundary、Security registry/boundary、相关 Go vet 通过过一轮，最终修改后重跑 |

真实 I/O 包括有界 FD 文件读取、固定 HTTP/Redis/Kubernetes 读取、pgx wire 诊断、受控本机进程、固定 SSH 传输和实际 workflow/SRE 日志读取。Docker daemon 未运行，尚未使用真实 MySQL/PostgreSQL 容器验证；wire fixture 不冒充实际数据库引擎验收。

## 独立审查修复

- 人工验收不能跳过 prepared/failed 原尝试；必须先核实原执行结果，失败仍需等价替代与覆盖，unknown 必须先对账。
- 自动验收只接受已实现、已登记的观察适配器；任意 Shell/SQL/MCP 返回同样数字不够。最终目标验收重读原引用证据、连接版本与有效期。
- 固定写命令失败也可能有部分效果；`service_restart` 失败保留 `effects_unknown`，不因类型化命令而自动结清。
- 恢复/迁移/只读索引使用统一未决谓词，保留 `failed + effects_unknown` 以及取消未核实风险；独立负回归已由失败转为通过。
- 无未决 impact 的普通资产也有显式恢复连接确认协议；须核对不可变来源引用和当前连接身份，不能伪造 impact 或自动批准旧配置。
- 本地 SSH 客户端退出不代表远端已停止；远端结果未知时保留风险。人工终端不会被孤儿治理关闭。

## 交付门槛

在最终真实入口矩阵、恢复与审批链、签名 Dev 和完整回归通过前，compiled enforcement coverage 保持不完整，不能对普通 Home 执行全局 enforce 或恢复开闸。管理请求不能提供布尔值绕过这一限制。

普通项目显式配置策略后的受控链路已有专项验证；这不代表未配置的旧项目已整体切换。全局模式、原生兼容及最终证据仍在集成。正式版、生产 Home、Release 与合并均未执行；按仓库流程经 develop PR 审阅后等待相应授权。
