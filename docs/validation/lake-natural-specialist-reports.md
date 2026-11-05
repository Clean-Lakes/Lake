# 专员报告移除状态尾注验收

日期：2026-11-04。功能代码 SHA：`7ec23f07bcf6da09d82bf90ccf10f604dd74194e`，基于 `origin/develop` 的 `caab241e89bc93f38e6395b69f3e85a285637296`；后续提交仅补本验证记录。

## 行为与兼容

Pilot 和专员频道的新报告只使用 outbox 中的原正文，宿主不再追加 `任务「…」· 已验收 · 验收：通过` 等状态尾注。任务状态继续在顶部和任务清单显示。

历史消息按准确项目、频道、消息 ID 和持久 outbox payload 对照：完整匹配旧宿主格式时，仅在读取投影中显示原正文。不改写原消息，也不根据类似正文或正则批量删字。普通 Pilot 文字、用户输入及报告正文中自己的引用保持原样。

升级前宿主已提交旧格式消息、但未提交投递回执的情形，可按原消息 ID 恢复确认，不重复插入消息。仅兼容同一 outbox 行的原正文或准确旧格式；正文冲突仍返回 409。任务和验收状态不从报告措辞推断。

## 本地验证

| 检查 | 结果 |
| --- | --- |
| `go test ./internal/web -count=1` | 完整包通过，249.567 秒 |
| 报告、outbox、来源及频道投影 race | AI 2.496 秒、Web 6.807 秒通过 |
| `go vet ./internal/ai ./internal/web` | 通过 |
| `python3 scripts/check_adk_runtime_boundary.py` | 通过 |
| `pnpm --dir web-agent check`、`pnpm --dir web-agent test:frontend` | 通过，588/588；无前端业务代码修改 |
| `git diff --check` | 通过 |

新增回归覆盖新报告在两个频道仅投递一次且正文不附加尾注、历史快照和频道分页的展示、丢失回执恢复、原消息不重写、正文引用及用户文字保留、跨项目/频道查询隔离、未投递报告不参与历史投影，以及修改正文仍拒绝对账。

源分支 race 命令：

```sh
go test -race ./internal/ai ./internal/web -run 'TestSuper(Report|PilotReport|ReportsProject|Outbox|ChannelProjection)' -count=1
```

## Lake Dev

macOS arm64 的干净本地集成提交：`68fe3c718130b257e36095d1944160d9515fc4ba`。保留此前 `427efeefc4ae7e55630c522c1412bf6451eae3a7` 的 Dev 候选，包括权限继承、普通任务自动推进、专员删除、Pilot 派单展示及任务资源解耦；这些候选不进入本 PR diff。集成时保留 `terminal_scope.go` 原派单投影，并新增历史报告正文投影。

集成提交额外通过：

```sh
go test -race ./internal/ai ./internal/web -run 'TestSuper(Report|PilotReport|ReportsProject|Outbox|ChannelProjection|Dispatch)|TestPilotDispatch' -count=1
scripts/build_lake_desktop.sh --dev --install
```

AI race 2.721 秒、Web race 8.205 秒通过，签名桌面构建安装成功。安装前通过 Dev 原生菜单“停止内核并退出”，确认旧 runtime 退出，再启动 `~/Applications/Lake Dev.app`。运行后端来自新安装目录，Home 为独立 `~/.lake-dev`。

原生深色工作台确认：Pilot 中当前发布专员的 917 单报告只显示结果正文，原状态尾注消失，顶部状态和现有 4 位专员仍显示。只读 API 与原表对照确认 4 个频道中 49 条历史报告按原 outbox 正文展示；安装前后用户消息、任务输入、原操作、审批、决策和事件账本的逐表指纹一致。原 14 条 Pilot 派单和 2 条数据库专员派单未重复，Pilot 权限以及当前项目的全局 MCP 继承保留。

本次未重新调用真实 MCP 或数据库查询，也未进行 Windows 原生验证。没有数据库 schema、前端协议或权限配置迁移。回退代码会恢复旧尾注展示，原消息和验收记录仍保留。

普通 PR 目标为 `develop`，未获本 PR 合并授权，不自动合并或发布。
