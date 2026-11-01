# Lake Security 任务闭环实施记录

日期：2026-11-02。分支：`codex/security-task-closure`，PR [#140](https://github.com/Clean-Lakes/Lake/pull/140) → `develop`。当前为最终验收候选；通过结果、tested SHA 和签名产物在本轮收口后固定。未合并、未发布，未安装或重启正式版。

## 五模块与实际代码

| 模块 | 实际实现 | 责任与边界 |
| --- | --- | --- |
| 任务中心 | `internal/ai/security_intent.go`、`security_runtime.go`、`security_tasks.go`、`security_parent.go`、`security_workflow.go`、`security_sre.go` | WorkGoal/步骤/尝试与限时 SecurityTask 分开；真实输入选择/续接，歧义先澄清；新目标不清旧风险，绝对期限不重置 |
| SOP 手册 | [独立计划](../../plan/feature-builtin-sop-catalog-1.md) | 本计划不交付 SOP UI、内容中心或匹配执行器；Items 仍是资产中心 |
| 安全控制 | `internal/security/`；AI 的 `security_policy/coordinator/catalog/confirmation/mode/shadow*.go`；Web `security_*routes.go` | 硬边界优先；项目允许、有限任务授权、精确单次批准分别验证；原提问仅选范围，原审批才签权；没有第二套审批账本 |
| 资源操作 | `security_execution/files/read_adapters/shell/ssh/provider/stdio/terminal*.go`；Web 的 `security_terminal.go` | 入口、准备、登记、I/O 重验；冻结配置、受控命令、当前 owner；无法约束的效果明确 opaque 或拒绝 |
| 任务档案与验收 | `work_closure*.go`、`work_manual_acceptance.go`、`work_acceptance_current.go`、`execution_ownership.go`、`orphan_reconciler.go`、`security_recovery*.go` | 原 operation/evidence 关联同 goal/step/attempt；验收时复核来源、版本、连接和新鲜度；失败保留，unknown 先核实 |

规范存储仍为 Home manifest 指定的 ADK runtime，Web 与 stdio 不能同时持有同一 Home。owner 默认租约 15 秒，每 5 秒续期/扫描；派发不享有扫描宽限。任务最长 24 小时，续接和批准不续期。诊断模板默认 50 次，受控服务重启默认 1 次，结构化读取默认 10 次；unknown 不退次数，确认 not_executed 最多返还一次。

## 测试与签名 Dev

最终命令、实际耗时和 SHA 待本轮检查结束后填入。此前集成失败不记为通过：原 SRE 汇总误套 owner 检查、恢复夹具把业务文件放入受保护 Home、native 测试未等后台释放 owner，均已定位并有针对回归。

- 完整 Go：`go test ./... -count=1 -timeout=8m`。
- Race：`go test -race ./internal/security ./internal/ai ./internal/web ./cmd/lake -run 'Security|WorkClosure|WorkAcceptance|WorkManual|ExecutionOwner|ExecutionMonitor|Orphan|Managed|TargetResolution' -count=1 -timeout=8m`。
- `go vet ./...`；`python3 scripts/check_adk_runtime_boundary.py`；`python3 scripts/check_security_boundary.py`。
- 原前端：`pnpm --dir web-agent check`、`pnpm --dir web-agent test:frontend`；Web build 随签名 Dev 执行。前端、shared 契约和原生客户端源码零修改。
- Fixture：`python3 -m unittest discover -s scripts -p 'test_dev_*py'`。
- 签名：`scripts/build_lake_desktop.sh --dev --install`，安装 `~/Applications/Lake Dev.app`。Home 为脚本新建的私有临时目录；不复制正式版凭据。
- 原生基础：`scripts/verify_security_runtime_dev.py --binary bin/lake --native "$HOME/Applications/Lake Dev.app/Contents/MacOS/Lake" --output <private-report>`。
- 任务与启用：`scripts/verify_security_task_dev.py --binary bin/lake --enforce --output <private-report>`，同脚本支持 `--native` 验证原生宿主。

任务 fixture 使用实际签名后端、实际 HTTP/SSE、真实有界 FD 读取及现有提问/审批接口，仅模型响应来自 loopback 合成提供者：一个原目标、两次原读取、一次任务范围审批、独立人工验收、预算 10→8、目标和 task 均关闭，随后真实启用该隔离 Home 并验证新项目默认 restricted。不以模型总结替代验收。

公共恢复 E2E：真实 checkpoint→restore→全部策略/连接映射确认→activate→关闭只读 owner→正常重启→新受限任务实际读取→逐来源解除阻断→新 task 重试原 goal。原失败/未知状态、原授权失效和未验收事实保持，缺少一个入口则仍拒绝激活。原提问/审批崩溃恢复保留恰好一次与 unknown 不重放断言。

## 覆盖与真实 I/O

编译时证明 **93 工具 + 13 入口族 = 106 项**。新工具不会在运行时自动进入已验证列表；精确覆盖不一致时不能启用。静态检查只是辅助，不能代替运行时/适配器证据。

| 适配器 | 实际验证 | 限制 |
| --- | --- | --- |
| 文件、日志 | 实际 FD、symlink/身份/预算、当前连接变化、Lake 自身控制面和秘密目录拒绝 | 不开放任意 Home 文件；不以宽目录授权绕过保护 |
| HTTP、Redis、Kubernetes | 实际 loopback HTTP/TCP/重定向/DNS及固定 API 读取 | Kubernetes exec 插件拒绝；未知二次效果不标只读 |
| PostgreSQL、MySQL | 固定探针/SQL准备、只读事务、响应/超时约束；PostgreSQL wire fixture | Docker daemon 未运行，未做真实 MySQL/PostgreSQL 引擎容器验收 |
| 本机、SSH、终端 | 实际进程组取消、SSH 握手固定 argv、断链、精确 agent PTY 写入/取消 | 本地 SSH 退出不证明远端已停；不停止整个人工终端 |
| MCP | 冻结真实 server/tool/config/catalog/binding/credential revision，变更后零派发 | arbitrary MCP 为 opaque，不信自报 readonly，不给任务通配 |
| workflow、SRE、schedule | 原模型/工具链、日志读取、父子来源、dueAt唯一与扣次/崩溃恢复 | 恢复不追补；disable 仅暂停未来，revoke/config变化才使旧来源失效 |
| provider、stdio、Memory | 实际 provider 请求计数、真实 stdio 管道和宿主 bridge；Memory 恢复/同意/遗忘隔离回归 | Memory 内部保持 bearqy 设计；未具备独立恢复资格的 provider 保持关闭，不启用 V2 |

所有已登记入口都接受安全检查，不等于每种效果都有受限适配器。任意 Shell/SQL/终端交互/复合动作无法证明边界时拒绝或 compatible 精确单次批准。Go 审批不是 OS 沙箱；用户明确批准的任意本机 Shell 仍拥有该 OS 账号权限。

## 性能

Apple Silicon 本机、非 race，固定 100 资源/20 规则/20 grants/并发 8；纯 Evaluate 和 SQLite 准备/登记分别记录，不含模型/网络/实际读取耗时。最终固定 SHA 的 p95 样本待填；集成期间 Evaluate 62µs、真实有界文件准备+登记 7.89ms，不作为最终候选结果。

## 独立审查与修复

- 人工验收不能跳过 prepared/failed 尝试；自动证据只允许登记的受信探针，任意 SQL/Shell/MCP JSON 不能伪造通过。
- 最终目标复验历史步骤证据的新鲜度、规范身份、所有 resource_set 连接版本；另一目标成功不能清除旧风险。
- 所有可能变更的失败（含类型化 service.restart）保留 effects_unknown；source-linked 恢复事实不能被普通 Resolve/startup/orphan 重写。
- 恢复索引统一纳入 failed/succeeded 的未决副作用，不只筛 unknown；空影响资源也必须有可信 catalog 映射确认。
- 原问题只提议授权范围；最后审批绑定差异、scope、TTL、预算；批准后重新 Prepare，外部 approved 字段无效。
- runtime/Home/control/凭据文件保护覆盖规范路径、别名、symlink 和硬链接；host token 只参与内部脱敏，不序列化。
- 旧 SRE 无任务临时汇总保持原合法行为，managed 错 root/owner 仍为零 provider 调用。
- shadow 对真实 managed prepared operation 纯比较新旧三态，不消费权限；未经确认放宽绑定到启用快照，显式 ACK 和启用分两步。缺少可信关联记 incomplete，不编造允许。

## 启用、兼容与未验证项

默认存量 Home 不因安装二进制就自动全局 enforce；逐会话保留原七项有效权限。显式项目策略受新控制，Home 强制模式须用管理 API/CLI 确认完整摘要并满足全部前置条件。强制后缺项目/策略不得退回 legacy；没有环境变量或清账本解锁选项。

新权威状态最低 reader 为 **2**。基础 reader 1 和早期正式二进制不属于可读回退范围；当前批次最早受支持的候选 SHA 在最终验证后固定。回退需理解 control/epoch/reader guard 的兼容二进制和[成对恢复协议](../security/checkpoint-and-recovery.md)，不能直接降级读取或将备份覆盖 control。

本轮仅 macOS arm64 Dev 验证；Windows/Linux 原生运行和真实数据库引擎验收未执行。SOP UI 与 Memory 内部重构不在本 Security 计划范围。独立审查代理的本地结论不冒充 GitHub 第三方账号审批。PR 等待用户对本 PR 的明确合并授权；日常 develop PR 无自动 CI，未触发额外 workflow。
