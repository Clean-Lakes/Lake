# C1 新增执行退役验证

日期：2026-10-27。基线：`origin/develop@081d66520dfc8f958a8eebbd84b675a183113613`。代码及本地 Dev 实测提交：`fc47a667840a4428b1d30ace32806b6ed4dde127`，构建时工作区干净；后续文档提交仅记录证据，不替代实测源码。

范围与数据处理见 [C1 契约](../design/strategy-execution-retirement-c1.md)。本阶段停止新执行，保留人工资产、历史记录及未知结果，不宣称 C2～C4 已完成。

## 自动检查

环境：macOS 26.4 / arm64，Go 1.26.6，Node 24.18.0，项目 pnpm 10.33.4。

| 检查 | 结果 |
| --- | --- |
| `go test ./... -count=1 -timeout=8m` | 全量通过，Web 198.340 秒 |
| `go test -race ./internal/ai ./internal/web ./internal/strategy -run '^(TestStrategy\|TestOnline\|TestInspectHost\|TestSREReadTimeoutCanRetry)' -count=1 -timeout=6m` | 通过：AI 13.833 秒、Web 55.939 秒、strategy 1.381 秒 |
| `go vet ./...` | 通过 |
| `python3 scripts/check_adk_runtime_boundary.py` | 官方运行入口与 provider-call AST 检查通过 |
| `corepack pnpm check`（web-agent） | 通过 |
| `corepack pnpm test:frontend`（web-agent） | 515 项通过，无失败、跳过或取消 |
| `scripts/run_lake_dev.sh` | 固定 pnpm Web 构建及签名后端构建通过，无 ZIP/DMG；原有大 chunk 提示仍在 |
| `codesign --verify --strict bin/lake` | 通过 |
| `git diff --check`、变更文档相对链接检查 | 通过 |

新增 Go 回归位于 [Web 退役测试](../../internal/web/strategy_retirement_test.go) 和 [ADK 退役测试](../../internal/ai/strategy_retirement_test.go)，覆盖旧配置/回执、API 拒绝、设置审计、普通轮次无辅助调用、租约停用、提取及实验未知结果/用量保留、两次真实子进程启动和在线报告幂等恢复。原 SRE 超时回归继续执行真实只读新采样，保留原 unknown 与后续成功操作；项目记忆授权/拒绝仍走官方 ADK。

旧“控制器纠错成功、生成候选成功、新建产品实验成功”正向测试随退役退出，改用已发布表结构的历史数据夹具验证读取、撤回、隔离与拒绝重启。没有通过测试开关重新开启已退役执行，也未放宽普通任务的权限或恢复判据。具体保留边界见 C1 契约。

## 签名 Lake Dev

1. 正常退出 Lake Dev，确认旧后端退出；对业务库与 ADK 库分别做 SQLite 一致性备份并检查完整性。备份在 Dev 私有目录 `~/.lake-dev/backups/c1-20261027-182253`，目录 0700、文件 0600。
2. 快速启动签名后端，构建来源 `fc47a667`、dirty=false，Dev 使用 `~/.lake-dev`，bootstrap HTTP 200。已安装的原生 Dev 壳复用新后端；没有安装包、原生代码或生产目录变更。
3. 比较备份与升级后完整行内容：7 条资产、10 个版本、6 条版本正文、5 条绑定、12 条来源、2 条审核、1 条晋升及 5 条复用条件均不变；该 Dev 库原有实验数量为 0。5 条设置均持久记录退役标记和旧选择，原 master/apply/budget 保留。业务库与 ADK 库 `integrity_check` 都为 ok。
4. 原生设置页只出现两项人工应用开关。全局仍开启，当前项目仍关闭；全局旧资产的正文、版本、停用绑定及导出/采用操作仍可查看，未执行内容写入或重新采用。历史来源/实验面板正常显示，无登记、生成或新建实验入口。真实 Dev 库无旧实验报告，报告内容/导出/撤回兼容由历史夹具回归覆盖。
5. 浅色、深色、约 943×723 窄窗口检查退役提示、共享选择器、滚动、焦点与圆角裁剪通过。检查后恢复原浅色及窗口尺寸，保持原项目；未改变资产开关。
6. 对实际 Dev 的 sources/proposals/experiments POST，以及包含完整必需字段的重新启用 PATCH，均得到 HTTP 410 / `strategy_execution_retired`。不完整设置 DTO 仍先返回 400，身份与请求校验没有放宽。

普通任务的无辅助请求、只读失败后的调整和记忆边界使用本地固定 provider + 官方 ADK 集成回归验证；本次没有发送新的真实模型任务或重跑收益试点。原 Pilot 历史调查仍能加载，不作为新的调查成功证据。

## 隔离旧版本兼容

将退役后的两库备份到临时私有 Home，不复制 secrets、不接触正式版。使用已安装 Dev 所附签名后端 `54a117c9af0a88f210c3adb2cf959b96ef711917` 短时启动并查询设置：正常启动，learn/correct/online 有效值均 false；退出后任务、提取运行、实验、资产正文和绑定逐行相同，两库完整性检查为 ok。

这只证明该已知旧版本可读取这份隔离副本，不意味着所有旧版本都受 C1 拒绝规则约束；旧程序仍可能允许用户手动重新开启。禁止用旧数据库覆盖当前 Dev/生产工作库。

## 未验证及后续

- Windows 原生界面和安装包未在本机执行；未触发手动 CI、Release 或生产操作。
- 本机历史实验为空，历史报告内容以自动化旧数据夹具覆盖；不将空列表视为真实旧报告视觉验收。
- 人工偏好承接、独立主标签收敛及物理删除仍属 C2～C4。惰性 Outbox、旧表、部分不可达执行器和公共兼容字段暂时保留；不能按本阶段删除的测试行数判断清理完成。
