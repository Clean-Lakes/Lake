# 移除命令的历史待核实门禁

功能提交：`b152f48bd779640e8cbaf607952ff104d1ec2d3a`。用户明确要求移除截图所示机制，让 Agent 的新命令按当前权限执行。

## 原因与变更

实际任务 `st_fe89ecf78c114e89275ec65b3eca3c62` 统计 10.100.33.52 自十月以来的重启次数。其 Bash 包含 `last`、`journalctl --list-boots`、`ls /var/log/wtmp* /var/log/btmp* 2>/dev/null`。通配符和重定向使该整条命令不能取得静态只读证明，于是命中了原项目旧 Operation `a2439cccbcdf9008e625b730d9340268159587d9f100997c693f9c434793e6e7` 的全局未知结果锁，命令没有派发。

本批按用户要求删除这层命令锁，而非继续为个别命令扩只读白名单：

- 宿主 Bash/commandExecutionId 绑定不再走同任务、同项目、旧 Go、共同成员的待核实阻断和跨调用参数去重。
- 删除命令的 SSH 历史目标/别名冲突回调、已核实变更目录围栏及其额外请求核验路径。
- 显式步骤可建立新 attempt；原未知 attempt 和 Operation 保持原样，不用“已核实”伪装恢复。
- 当前资源、配置、权限、审批偏好、SSH 信任、执行代次、停止、期限及 Plan/明确只读范围继续生效。同一个原调用 ID 不自动重发；新 ID 的同参数命令可以执行。原 unknown 仍不能充当成功证据。
- 非命令适配器的现有结果合同保留。没有修改用户数据中的策略、原操作、效果复核或 Memory 依赖。

## 自动验证

固定 Node 24.14.0，临时 Home 和合成凭据。受控模型通过真实 Agent SDK，SSH 为本机回环测试服务。

| 检查 | 结果 |
| --- | --- |
| runtime TS 类型、bundle | 通过 |
| runtime 全部源码 | 249 项：245 通过、4 个原条件跳过（可选 Claude-Mem/Linux 专属扫描） |
| 最后账本定向复测 | 27 项通过，包括非 Bash/缺少宿主绑定不能冒用命令分支 |
| 打包运行时全部 SDK 测试 | 185 项全部通过 |
| ADK runtime boundary | 通过 |

本批无共享命令策略、React、Swift 或样式变更，不把此前的完整 Web 测试重复算为本批结果；桌面构建重新构建 Web。

真实 SDK 回归：

1. 保留同项目 old unknown 和 legacy unknown，派发与截图相同的通配符/重定向命令。它仍为 `readOnly=false`，没有伪造只读证明，真实 SSH 通道取得当前结果。
2. 自动执行打开时直接执行；关闭时等待当前 Bash 审批，批准前 SSH exec 为零。SSH 信任仍需要原准确指纹确认。
3. 同任务第一条命令在独立 SSH 夹具中写入标记后退出非零，保留 unknown；第二条命令继续追加并读取，真实文件与回执一致。两笔 exec，原失败保留，整个任务不冒充 pass。
4. 传输测试覆盖 exec 抛错、请求后断线和通道断线，新的普通命令和日志查询继续执行；旧调用 ID 不再次进入 exec，旧 CommandRecord/Operation 在重开库后保持。
5. 单测覆盖新任务、共同任务、已核实历史目录及相同命令的新 ID；明确计划重开尝试时不核实旧未知状态。完整回归仍覆盖当前权限拒绝、配置变化、停止、审批和只读范围。

## Lake Dev 验证

`scripts/build_lake_desktop.sh --dev --install` 及 `codesign --verify --deep --strict` 均通过。`~/Applications/Lake Dev.app` 的 `build-origin.json` 为功能提交、dirty=false、TypeScript；后端 SHA-256 `44f54edfc223a32a0e137e8c773287b978b8f112a9fe6dafc9f4c55f318a68fa`。确认没有活动 Worker 后通过原生菜单停止旧内核，再安装启动；生产应用与 Home 未改动。

通过原专员频道提交标明“移除旧操作锁复测”的续查要求，继续同一统计 Task 第二代：

- Task：`st_fe89ecf78c114e89275ec65b3eca3c62`，root `turn_62fa2b19-977d-44d9-9c61-73f009d04ab5`；原绝对期限 `2026-11-10T07:33:57.051Z` 保持。
- 本轮唯一 Bash Operation `756b3d5cd0147429ad1d26549586d53b7ffaf90a1c557357dbae11a204aad951` 为 succeeded；绑定原服务器 `eca87dce9daaad6ef2fbbba90b1e8b99`。命令仍含 glob、重定向，`readOnly=false`，SSH 派发为 channel_open；没有修改分类器或旧 unknown 来放行。
- 原 Task 正常 completed/pass，本轮卡片无失败。原生专员频道实时显示“已验收”和最新总结，原失败折叠到上一轮。
- 从真实回执独立提取 `reboot` 行核对，2026 年 10 月 1 日至 11 月 9 日记录到 **8 次启动**：10 月 1 日、15 日、23 日三次、27 日、11 月 3 日和 8 日。wtmp 从 1 月开始，现存 journal 只有 11 月 3 日以来两轮；报告说明较早启动无法用现存 journal 独立核对。这不是“8 次异常重启”的证明。
- 原来源任务 `st_39bbd8864757f39c01831e28eba96189` 的 Goal/Worker/Operation/Attempt/memoryReads 共 7 条原始记录，安装及复测后逐条哈希完全不变。比较清单 SHA-256 为 `47f3b7c9e4ff524693c8fc8d1f9852587e9021784a43476d35cdc4a5bdf5c99a`，其中原未知操作仍为 unknown。

真实服务器只运行本轮读取启动历史的查询。允许新写命令继续的验证使用隔离的 loopback SSH 夹具，不对用户服务器写入。Windows 和可选 Claude-Mem 本次未验证。

## 回退与影响

新命令即使与历史未知操作有相同参数，也不再被历史锁拒绝，可能再次产生该命令的实际效果；这是本次用户授权的行为调整。现有权限/确认仍逐次执行。回退实现及提示词，不删除原账本，不自动重放历史。不包含合并或正式发布。
