# N1 自然记忆基础验证

日期：2026-10-28。基线 develop 为 a566ad14dc3c8dc79d023a2046c4e55630bb7d1b（#110 合入后）。实际代码、全量检查及签名 Dev 提交为 **7ab1da2156b04920a2c4ca7096fc240cfe397d97**，构建时 dirty=false；后续文档提交只记录验证。

N1 契约见[统一记忆基础](../design/natural-memory-foundation-n1.md)。本阶段交付管理基础、设置映射和旧偏好承接，不交付自动意图识别、后台语义合并、压缩提取或新召回。

## 自动化检查

| 检查 | 结果 |
| --- | --- |
| `go test ./... -count=1 -timeout=8m` | 干净代码全量通过：AI 40.772 s、Web 177.432 s，其余包通过 |
| `go test -race ./internal/web -run '^(TestNaturalMemory\|TestMemoryV2\|TestStrategyRetirement)' -count=1 -timeout=6m` | 通过，9.958 s |
| `go vet ./...` | 通过 |
| `python3 scripts/check_adk_runtime_boundary.py` | 官方入口及 provider-call AST 检查通过 |
| 固定 pnpm 的 `check` / `test:frontend` | 类型检查与 518 项测试通过，无失败或跳过 |
| `scripts/run_lake_dev.sh` 两次运行 | 新 Web 构建、持久身份签名后端与 Dev Home 检查通过，不制作 ZIP/DMG；原有 chunk 提示保留 |
| `codesign --verify --strict bin/lake` | 通过；二进制 SHA256 与来源 manifest 一致 |
| `GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go test -c ./internal/web -o /tmp/lake-n1-web-windows.test.exe` | 交叉编译通过，未运行 Windows exe 或 Windows UI |
| 文档链接、样本身份/类别/阈值、diff | 通过 |

新增 [Go 回归](../../internal/web/natural_memory_test.go)包含 10 个测试及 V1/V2 HTTP 子场景：

- 承接/重复请求/撤销保留准确正文和原 binding，原 resolver 仅选择同一份准确版本。
- 过时 preview、映射/正文/绑定后续修改、并发 CAS 和旧撤销不能覆盖新数据；成功回执可重放，来源撤回后不能借旧回执绕过检查。
- 项目隔离、明确全局偏好的项目停用覆盖、私有晋升来源隐藏和撤回均保留。
- 旧同意不转新同意；新 true 拒绝，false 的 revision/CAS 不改原项目记忆设置。
- 首次迁移私有备份、重复打开、未知 hash 拒绝、DDL 中途失败事务回滚；无部分 marker。
- 严格 JSON、宿主项目、V1/V2 项目记忆适配与 C1 旧写接口 410。

[前端新增回归](../../web-agent/web/test/natural-memory.test.ts)覆盖实验/不可用说明、无自动启用控件、精确预览 token/revision、重试复用幂等身份，以及只读操作不走旧策略写路径。未修改或删除原有运行回归。

## 日常 Dev 升级与真实界面

平台：macOS 26.4 / arm64，Go 1.26.6、Node 24.18.0、项目 pnpm 10.33.4。只操作 Lake Dev 与 `~/.lake-dev`，没有安装包或生产操作。

正常退出 Dev，确认旧 PID 不存活。升级前对业务和 ADK 两库作 SQLite 一致性备份，目录 `~/.lake-dev/backups/n1-20261028-142851` 为 0700、文件为 0600，两库完整性正常。N1 首次启动还生成一份业务库自动迁移备份；第二次启动未重复生成。

首次启动后逐行比较原库：7 条资产、10 个版本、6 条正文、5 条绑定、12 条来源、5 条策略设置、6 条项目记忆设置和 6 条项目记忆完全相同。新 naturalMemoryLinks/naturalMemorySettings 均为 0，证明没有自动承接或同意继承。

在 Dev 新建“**N1 记忆基础验收 20261028**”，仅放入虚构的手写项目偏好与一条手写项目记忆；没有配置新 provider、发送模型任务或执行资源命令。通过原生界面完成：

1. 从策略资产的“记忆内容承接 · 实验”查看真实偏好、原项目记忆及原设置。
2. 预览准确正文、v1、当前项目/core 范围、原条件、排序优先级 7 与互斥组 report；确认承接，显示已纳入管理。
3. 撤销承接，界面显示已撤销；原正文、采用 binding 和使用设置均保留。数据库映射 revision=2/state=undone，保留两条变更，未新增自动同意。
4. 浅/深主题、约 943×723 窄窗口检查提示换行、滚动、按钮/面板圆角、预览和共享选择器 Escape/焦点。验证后恢复浅色与原窗口尺寸；未保存任何原资产开关。
5. 实际 Dev PATCH autoEnabled=true 返回 409。测试项目保留供复查；未开启自动记忆。

随后正常退出原生 Dev，通过原终端 Ctrl+C 停止已核对路径的后端，再用同一干净提交快速启动。对 9 张自然记忆及旧资产/记忆关键表的完整行 hash 比较一致；映射、两条变更和原设置没有重复提交。业务与 ADK 库 `integrity_check` 均为 ok；bootstrap HTTP 200，重新打开原生 Dev 正常连接。最终保留 Dev 运行。

## 真实旧二进制隔离回退

使用临时 0700 Home，仅复制两库一致性副本，不复制 secrets 或 provider 配置，不访问生产。顺序如下：

1. N1 签名后端打开副本，对测试偏好重新承接，得到 mapped v1。
2. 停止 N1，用已安装 Dev 附带的签名后端 `54a117c9af0a88f210c3adb2cf959b96ef711917` 打开相同副本；新元数据逐行不变，原执行 flags 保持 false。
3. 在旧 API 明确编辑并采用测试偏好 v2，随后停止旧后端。
4. N1 再打开副本：管理层保留 mapped contentRevision=1 和准确旧正文，显示 conflict；旧绑定仍准确采用 v2，没有静默改成 v1 或生成第二份注入。两库完整性正常。

这证明该已知旧版的隔离读写与再升级路径，不意味着所有旧程序理解新 schema 或具备 C1 的写接口拒绝规则。未将副本覆盖真实 Dev。

## 固定样本与剩余阶段

[自然意图样本](../../internal/web/testdata/natural-memory-intent-v1.json)为 60 个虚构案例，SHA256 为 `922f2a4f4b30ae23ba5c178af1456a0a635fff69f1b37505b4bd4f62bc21f084`；含明确来源身份，更正类含独立旧偏好。每类 10 条，30 个保存、20 个忽略、10 个待核实；每轮错误自动写入/范围/来源为 0、正向召回至少 27/30，共 3 轮。样本和判据已冻结，N1 没有执行分类器或模型质量评测。

- N2～N5 尚未交付；N1 的承接撤销不等于后续自动内容更新的撤销。
- 运维 V2 门控仍为 false，原有事实/证据质量、竞态和平台门槛保留。未运行 Windows 原生 UI、安装包或手动 CI。
- 不支持将复杂方法自动改为全局偏好；未承接/拒绝/撤回内容不因升级激活。
- 标题沿用当前资产标签，准确版本指正文及其条件/来源；旧 schema 没有不可变历史标题，不能把当前标签当成历史标题快照。
