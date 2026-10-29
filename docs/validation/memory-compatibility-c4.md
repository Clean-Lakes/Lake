# C4 兼容验收与剩余缺口

日期：2026-10-29，macOS arm64。对应 [C4 手册](../design/memory-compatibility-c4.md)与[清理计划](../../plan/refactor-harness-inspired-cleanup-1.md)。**本地验收通过；Windows 原生验收按本次用户选择保留缺口。** 没有运行手动 CI、打包、发布或操作生产。

## 合并与验证源码

已按用户授权审查并 squash 合并 [PR #117](https://github.com/Clean-Lakes/Lake/pull/117)。head `a72be1bfc4fe9a63dfd5ad3b45d93ed047331b0e` 与合并 `01c5e139b79914afc351b71c517b8275f7eacafd` 树一致；补跑 C3/N5/退役重点回归，AI 1.609s、Web 0.857s。已删除远端/本地 `codex/strategy-runtime-cleanup-c3`，未清理其他人的分支或 worktree。

C4 从上述最新 develop 独立开发。最终全量/race、兼容 runner、前端/Python/静态检查、Windows 交叉构建、隔离后端与签名 Dev 来源为 **`3d317c0aa4bf0a3add84df687660944b98b5d5c6`**，构建 dirty=false，来源/hash 与 codesign 严格校验通过；其后只补本验收与结构化证据。当前指南、脚本和回归的初版为 `298b9352`，三个固定 Dev 功能场景在该提交完成，最终源码另补一次新会话冒烟；准确源码分别保存在 JSON，不混记为全部重跑。

本阶段没有生产 Go/React 逻辑修改、数据库迁移或历史 SQL/hash 变更；只新增恢复回归、整理验证工具、重命名原生测试用途及收敛文档/CI 引用。旧研究原始报告、分数和 inconclusive 不改写。

## 检查结果

完整命令见 [checks.json](memory-compatibility-c4/checks.json)。

| 检查 | 结果 |
| --- | --- |
| `go test ./... -count=1 -timeout=8m` | 全通过，AI 41.697s、Web 182.653s |
| AI/Web/strategy 定向 race | 全通过，AI 27.814s、Web 58.924s、strategy 2.562s |
| `go vet ./...`、ADK 边界检查 | 通过 |
| 新兼容 runner | [regression.json](memory-compatibility-c4/regression.json)：267 个顶层 pass、6 skip；含子项435 pass、6 skip、0 fail。两个已由父进程驱动的 crash helper及四个显式真实模型评测入口跳过；不是六项已验收的质量测试 |
| 固定 pnpm 类型与前端测试 | 551 pass、0 fail/skip；新 Web 构建通过 |
| Python Dev/报告/分支规则 | 14+4+4 项通过；保留队列竞争、只发一次、旧轮次不能通过新消息等待；新增空包/helper-only/子项失败不能伪造通过及旧入口无副作用断言 |
| 三份工作流 | Ruby Psych 语法、仅 master PR、同仓库 develop 来源断言通过；没有 Actions 执行。手动兼容 job 无打包步骤，日常 push/develop PR 仍不触发 CI |
| Windows 后端及客户端测试 | amd64 交叉构建和两个实际 WebView2 用例的测试程序交叉编译通过；**没有 Windows 原生执行** |

## 隔离后端、重启与旧版副本

[isolated-dev.json](memory-compatibility-c4/isolated-dev.json) 由新脚本在最终签名后端运行。使用新的私有临时 Home、本机合成 SSE 模型、两次实际 HTTP/官方 ADK 请求；没有读取现有工作库/供应商凭据，没有资源工具操作，不是模型收益或桌面验收。

- 保留人工准确正文、采用 revision/hash 和未采用草稿；显式承接到统一管理后，实际请求只有一份原正文，未采用内容没有注入。
- 五个旧执行写入口和旧开关启用均返回 410，不创建新任务；两个普通请求无旧修订工具、额外模型派发、实验清单或纠错记录。
- 两次后端停止/重启后，51 张策略/自然记忆表和两张 ADK 历史表行 hash 一致；准确采用仍可读取，自动积累/自然偏好使用同意仍独立关闭。
- 在已经停止、仅有虚构数据的副本上执行最终版本 → 已安装签名旧版本 `54a117c9af0a88f210c3adb2cf959b96ef711917` → 最终版本。旧版只启动/读取 bootstrap，不执行任务或模型请求；53 张表 hash 保真、两库完整性通过，provider 请求总数仍为2。旧二进制 hash 与其 build-origin 对照通过；没有将副本覆盖到工作 Home。

未知账本/预留不退款、不续跑由新的复合 canonical 恢复回归及原 C1/ADK 真实进程退出回归验证。上述旧版副本只证明这份无在途任务的合成内容可读取往返；不承诺任意旧版本或活动/unknown 任务的降级写入安全。

## 固定 Home 的真实 Dev

运行 `scripts/run_lake_dev.sh`，保留已安装 `~/Applications/Lake Dev.app`，没有 ZIP/DMG。只更新 Dev 后端/Web，生产 `Lake.app`、`~/.lake` 和凭据未修改。

停止原 Dev 后通过 SQLite backup API 为两库建立私有一致性备份。首次 C4 启动、发新消息前，原 51 张策略/自然记忆表和两张 ADK 历史表行 hash 完全一致。备份只保存在本机，不提交数据库或 token。

[dev.json](memory-compatibility-c4/dev.json) 记录已有虚构测试项目的四次真实 deepseek-flash 调用：

| 场景 | 结果 |
| --- | --- |
| 新会话沿用项目表达偏好 | 「【协调偏好】2 加 2 等于 4。」；准确 project 偏好准备记录存在 |
| 另一新会话要求只回复数字4 | 只回复「4」；当前要求覆盖已准备的偏好 |
| Pilot 协调层表达 | 沿用项目前缀；没有创建 SRE 调查、专员或资源操作，测试项目 Pilot 恢复原关闭值 |
| 最终 3d317c0a 新会话 | 「【协调偏好】2加2等于4。」；新 Dev 实际显示且可继续使用 |

四次主请求报告总用量60,379 tokens（输入60,147、输出232）。普通消息/模型能力仍有成本；没有额外重跑180次分类、旧收益试点或自动提取。本阶段没有改变提炼分类器/冻结判据，不宣称新质量或收益结论。

全部请求前后 prompt-manifest 记录187、nativeCorrection记录10，均无增长；旧 N5 的1条清单仍可通过鉴权 API和原生下拉查看。没有删除原始来源或用户资产，自动积累仍关闭，项目使用仍按原选择开启。

原生 Dev 实查实验标签、兼容入口默认折叠、旧清单选择与读取、共享下拉键盘和焦点、浅/深色和1003×853窄窗口。无新增裁切/横向溢出，外观和窗口大小已恢复：[偏好回复](memory-compatibility-c4/dev-recall.jpg)、[旧清单/浅色](memory-compatibility-c4/history-light.jpg)、[深色](memory-compatibility-c4/history-dark.jpg)、[窄窗口](memory-compatibility-c4/history-narrow.jpg)。旧纠错卡的 canonical 解码/恢复由新 Go 回归覆盖；本次未在固定 Home 人工伪造旧卡或重写真实未知记录。

## V01～V13 对应与剩余边界

[matrix.json](memory-compatibility-c4/matrix.json) 将13项原计划场景对应到准确测试名称；生成时逐一核对这些名称出现在当前报告且为 pass。V01～V12本地覆盖包含退役、防旧回执复活、迁移、拒绝、准确采用/承接、跨项目来源撤回、复杂条件/Skills、普通/Pilot、可选诊断故障与真实持久化/授权失败、上下文/停止和unknown恢复。V13是macOS通过、Windows原生按用户选择延后；不能用交叉编译或N5历史CI替代当前原生结果。

仍需保留的适配器及原因见 [C4 手册](../design/memory-compatibility-c4.md)：复杂条件旧资产、准确采用/撤回、SQL/墓碑/旧回执、历史 outbox/manifest/nativeCorrection 和拒绝 stub。不自动扩大范围，不删除用户内容来完成清理。新自然记忆保持实验和默认关闭，运维V2、任意模型收益及生产发布均未由本验收放行。

代码可经PR revert回退；本次没有数据迁移。回退不覆盖工作数据库，不清除最新撤回或操作账本；旧程序兼容只在停止后的离线副本验证。生产提升前需另行完成Windows原生及最终发布候选集成检查，相关CI/发布授权不能由本PR推断。
