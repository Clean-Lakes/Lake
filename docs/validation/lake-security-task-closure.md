# Lake Security 任务闭环实施记录

日期：2026-11-02。分支：`codex/security-task-closure`，PR [#140](https://github.com/Clean-Lakes/Lake/pull/140) → `develop`。后端实现和自动化验收以代码候选 `b2405d9fae393ee675702fd86b01ed8f174be0d0` 固定；本记录后的提交只更新文档。原生签名运行已通过，实际窗口检查及截图因 Mac 锁屏仍未完成（TASK-049），最终收口 TASK-050 保持进行中。未合并、未发布，未安装或重启正式版。

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

代码 SHA：`b2405d9fae393ee675702fd86b01ed8f174be0d0`。最终完整 Go 回归已通过（AI 117.534s、Web 277.919s，所有其余包通过或无测试）。上一个完整候选 `1d5e0b24ecba4495854f6ebb1018425aa6dc9689` 全仓通过（AI 及其余包通过、Web 318.531s），在其后仅追加 mode 响应有界投影及验收脚本等待 task 最终提交；该补丁 AI/Web/CLI race 已通过。此前集成失败不记为通过：原 SRE 汇总误套 owner 检查、恢复夹具把业务文件放入受保护 Home、native 测试未等后台释放 owner，均已定位并有针对回归。

| 验证 | 代码 SHA / 结果 |
| --- | --- |
| 完整 Go | `b2405d9f`：全仓通过，AI 117.534s、Web 277.919s、CLI 2.367s |
| 全部安全/闭环相关 race | `1d5e0b24`：AI 166.094s、Web 41.936s、CLI 4.405s；随后 `b2405d9f` mode/shadow/CLI 增量 race：AI 21.691s、Web 9.081s、CLI 10.398s |
| vet / 两套边界 | `b2405d9f` 全仓 vet、ADK AST boundary、Security registry/hooks 全通过 |
| 原前端 | `1d5e0b24` 类型检查和 556/556 测试通过；`b2405d9f` Dev 再次完成类型检查/Web 构建，前端/shared/client 文件均无 diff |
| Dev 脚本 | `b2405d9f`：16/16 unittest 通过，含真实进程持锁/父退出后的等待回归 |
| 签名 Dev | `b2405d9f`：构建安装及两项原生宿主脚本通过，报告见下文；原生截图未验证 |

- 完整 Go：`go test ./... -count=1 -timeout=8m`。
- Race：`go test -race ./internal/security ./internal/ai ./internal/web ./cmd/lake -run 'Security|WorkClosure|WorkAcceptance|WorkManual|ExecutionOwner|ExecutionMonitor|Orphan|Managed|TargetResolution' -count=1 -timeout=8m`。
- `go vet ./...`；`python3 scripts/check_adk_runtime_boundary.py`；`python3 scripts/check_security_boundary.py`。
- 原前端：`pnpm --dir web-agent check`、`pnpm --dir web-agent test:frontend`；Web build 随签名 Dev 执行。前端、shared 契约和原生客户端源码零修改。
- Fixture：`python3 -m unittest discover -s scripts -p 'test_dev_*py'`。
- 签名：`scripts/build_lake_desktop.sh --dev --install`，安装 `~/Applications/Lake Dev.app`。Home 为脚本新建的私有临时目录；不复制正式版凭据。
- 原生基础：`scripts/verify_security_runtime_dev.py --binary bin/lake --native "$HOME/Applications/Lake Dev.app/Contents/MacOS/Lake" --output <private-report>`。
- 任务与启用：`scripts/verify_security_task_dev.py --binary bin/lake --enforce --output <private-report>`，同脚本支持 `--native` 验证原生宿主。

[签名验收报告](lake-security-task-dev.json)：Dev build-origin 的 gitHead 为 `b2405d9fae393ee675702fd86b01ed8f174be0d0`、`dirty=false`；backend SHA256 `245288b35324f37e269db52d45a2116f06abffd876b1ea76a8db2556f2eb4473`。两项最终脚本均使用实际原生 Dev 宿主并成功；截图工具报告 Mac 锁屏，不能据此宣称原窗口视觉验收通过。

任务 fixture 使用实际签名后端、实际 HTTP/SSE、真实有界 FD 读取及现有提问/审批接口，仅模型响应来自 loopback 合成提供者：一个原目标、两次原读取、一次任务范围审批、独立人工验收、预算 10→8、目标和 task 均关闭，随后真实启用该隔离 Home 并验证新项目默认 restricted。不以模型总结替代验收。

最终 SHA 的两项公共恢复 E2E 明确 PASS（正向 0.81s，非 skip）：真实 checkpoint→restore→全部策略/连接映射确认→activate→关闭只读 owner→正常重启→新受限任务实际读取→逐来源解除阻断→新 task 重试原 goal。原失败/未知状态、原授权失效和未验收事实保持，缺少一个入口则仍拒绝激活。原提问/审批崩溃恢复保留恰好一次与 unknown 不重放断言。

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

Apple Silicon 本机、非 race，固定 100 资源/20 规则/20 grants/并发 8；纯 Evaluate 和 SQLite 准备/登记分别记录，不含模型/网络/实际读取耗时。固定上述代码 SHA 的实际样本：Evaluate p95 **100.667µs**；128 组原 SQLite 登记 p95 **752.375µs**、安全登记 **1.726167ms**，增量 **973.792µs**；64 组真实文件目标解析+FD 元数据+规范准备+原登记 p95 **8.802583ms**。符合纯 Evaluate <1ms 与登记增量 ≤10ms 目标。运行时同时有全仓回归，不将单机样本当作所有环境的延迟保证。

## 独立审查与修复

- 人工验收不能跳过 prepared/failed 尝试；自动证据只允许登记的受信探针，任意 SQL/Shell/MCP JSON 不能伪造通过。
- 最终目标复验历史步骤证据的新鲜度、规范身份、所有 resource_set 连接版本；另一目标成功不能清除旧风险。
- 所有可能变更的失败（含类型化 service.restart）保留 effects_unknown；source-linked 恢复事实不能被普通 Resolve/startup/orphan 重写。
- 恢复索引统一纳入 failed/succeeded 的未决副作用，不只筛 unknown；空影响资源也必须有可信 catalog 映射确认。
- 原问题只提议授权范围；最后审批绑定差异、scope、TTL、预算；批准后重新 Prepare，外部 approved 字段无效。
- runtime/Home/control/凭据文件保护覆盖规范路径、别名、symlink 和硬链接；host token 只参与内部脱敏，不序列化。
- mode 管理投影最多 100 条、优先未确认放宽，支持逐批 ACK；1000 条事实/300 项放宽回归验证隐藏事实仍改变完整摘要并阻止启用，CLI 的 64KiB 上限不放大。
- 旧 SRE 无任务临时汇总保持原合法行为，managed 错 root/owner 仍为零 provider 调用。
- shadow 对真实 managed prepared operation 纯比较新旧三态，不消费权限；未经确认放宽绑定到启用快照，显式 ACK 和启用分两步。缺少可信关联记 incomplete，不编造允许。

## 启用、兼容与未验证项

默认存量 Home 不因安装二进制就自动全局 enforce；逐会话保留原七项有效权限。显式项目策略受新控制，Home 强制模式须用管理 API/CLI 确认完整摘要并满足全部前置条件。强制后缺项目/策略不得退回 legacy；没有环境变量或清账本解锁选项。

新权威状态最低 reader 为 **2**。基础 reader 1 和早期正式二进制不属于可读回退范围；本批次已验证的最低兼容代码 SHA 为 `b2405d9fae393ee675702fd86b01ed8f174be0d0`，未验证任何更早 reader-2 二进制作为回退候选。回退需理解 control/epoch/reader guard 的兼容二进制和[成对恢复协议](../security/checkpoint-and-recovery.md)，不能直接降级读取或将备份覆盖 control。

本轮仅 macOS arm64 Dev 验证；Windows/Linux 原生运行和真实数据库引擎验收未执行。SOP UI 与 Memory 内部重构不在本 Security 计划范围。独立审查代理的本地结论不冒充 GitHub 第三方账号审批。PR 等待用户对本 PR 的明确合并授权；日常 develop PR 无自动 CI，未触发额外 workflow。
