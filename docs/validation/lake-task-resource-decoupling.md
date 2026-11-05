# 任务与资源解耦验收

日期：2026-11-04。功能代码验证提交：`17d3ea5bcc11a97bc5f33ed87e1716f314a8b0e9`；基线：`origin/develop` 的 `caab241e89bc93f38e6395b69f3e85a285637296`。后续提交仅整理本记录和实施计划。

## 行为

原来用数据库 A 建立任务后，补充集群 B 会触发“原工作目标绑定了其他资源”或固定计划资源检查。现在任务以业务目标为身份：资源未确定时可以先建任务，同一目标执行中可以追加项目内资源，无需换 Task、Worker 或 GoalID，也不刷新原期限、步骤、尝试和累计轮数。

- `work_begin.asset_refs` 可省略；首次参考和实际操作中发现的资源作为历史记录追加。相同资源及配置身份重复记录不产生新修订，配置变化保留旧快照。
- 普通 SRE 计划从当前项目目录解析候选资源；任务视图从准确项目、会话和目标的操作账本补全已涉及资源。该投影不写回执行权限、验收或操作状态。
- 有 Security 契约的恢复使用原操作、句柄、连接修订和当前权限验证，历史未使用资源的变化不再阻断恢复，也不继承前台终端。
- Pilot 提示明确：同一业务目标的资源澄清交回原任务；独立交付物仍使用独立 Worker 和上下文。

任务资源参考不签发权限。实时项目权限、明确目录边界、原操作审批与连接版本、保存的 workflow 冻结模板、子角色范围和未知副作用核验继续生效。缺少受信操作描述的旧自动恢复仍走保守快照核验路径。

## 自动验证

| 检查 | 结果 |
| --- | --- |
| `go test ./internal/ai -count=1` | 通过，104.551 秒；固定在功能代码提交上完整运行 |
| `go test ./internal/ai ./internal/web` 中的 Web 完整包 | Web 通过，277.018 秒；该次 AI 失败后已更新预期工具契约，并以独立 AI 完整运行取得上述通过结果，不将原组合命令记为通过 |
| 相关 AI 回归及 race | 通过；最终源分支 race 11.981 秒 |
| `go vet ./internal/ai ./internal/web` | 通过 |
| `python3 scripts/check_adk_runtime_boundary.py` | 通过 |
| `pnpm --dir web-agent check`、`pnpm --dir web-agent test:frontend` | 通过，588/588；本 PR 无前端业务代码修改 |
| `git diff --check`、计划结构及声明 ID 校验 | 通过 |

覆盖用例：同一 GoalID 跨数据库/集群资源、无资源或待澄清目录建单、旧 Binding 历史保存、重复补充幂等、实际操作资源投影的项目/会话隔离、普通 SRE 使用后发现资源，以及官方 SDK 根据原机器事件恢复。负向用例保留跨范围访问、原操作连接变化、权限撤回、过期任务、伪造观察源、workflow 模板和子角色边界的拒绝行为。工具描述变更对应更新 `strategy-disabled.v1.json` 的工具哈希，没有重录提示词正文基线。

## Lake Dev

平台：macOS arm64。签名构建和安装命令：`scripts/build_lake_desktop.sh --dev --install`。

已安装的干净本地集成提交为 `427efeefc4ae7e55630c522c1412bf6451eae3a7`，包含上述功能代码，并保留此前 Dev 候选 #162、#165、#166、#168、#170、#171、#172。集成分支仅用于本地 Dev，未推送为 develop 更新；这些候选不混入本 PR diff。

集成提交额外通过：

```sh
go test ./internal/ai -run 'TestC3PromptAssemblyMatchesPreCleanupBytes|TestStrategyDisabledPromptGolden|TestSuperWorker' -count=1
go test -race ./internal/ai ./internal/web -run 'Test(TaskResource|OrdinarySREPlan|WorkBegin|WorkCanBegin|WorkBinding|WorkResource|SuperConfirmedTask|SuperWorker|SecurityManagedWorkWait|SecurityWorkMachineResume|SecurityWorkflow|SecurityPermit|SpecialistDelete|Delete.*Specialist|DeletedSpecialist)' -count=1
pnpm --dir web-agent check
pnpm --dir web-agent test:frontend
```

结果：契约回归 2.722 秒，race 的 AI 26.404 秒 / Web 8.676 秒，前端 589/589 通过。构建包含新的 Web 资产及已签名后端，随后通过原生“停止内核并退出”后的安装流程启动 `~/Applications/Lake Dev.app`；运行后端与安装目录内二进制一致，Home 为独立 `~/.lake-dev`。

原生工作台观察到现有 4 位专员、项目资源目录及会话正常显示。安装前后只读核验还确认：

- 用户消息、任务输入以及原操作、决策和审批账本的逐表指纹一致，未清理旧风险记录或重放操作。
- Pilot 的 14 条派单、数据库专员的 2 条派单保留同一 canonical 消息，无重复；Pilot 权限设置保留。
- 当前项目继承的已启用全局 MCP 仍为 `gos` 和 `zmy知识库`，其他 4 个项目未启用该继承。

本次没有在真实服务器、数据库或 MCP 上重跑用户的业务查询或数据比较；跨资源执行行为通过隔离测试模型和原操作回归验证。未进行 Windows 原生验证。

## 数据与回退

无数据库 schema、前端协议、资源目录或 Memory 开关迁移；不更改项目权限配置。回退代码保留已有资源历史和原操作账本，旧版本可能重新施加固定任务资源检查。未决操作仍按其原身份核验，不能通过换资源引用或清除上下文重复执行。

普通 PR 目标为 `develop`，以本地验证为准；创建 PR 不代表已获准合并或发布。
