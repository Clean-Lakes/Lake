# Pilot 派单消息验收

日期：2026-11-04。派单实现提交 `bc2bfce4abf68cda4265ec5ca4194aa646d5a4ef`；会话就绪修复提交 `0eb0ba60`。

## 最终行为

- Pilot 会话显示实际交办消息：“@专员，请去做一下：任务”。点击接收专员可进入其长期频道。
- 接收频道显示同一条带 Pilot 署名的消息，替代旧版转贴的黑色用户气泡。用户直接发给专员的消息仍显示为用户消息；Pilot 的后续补充显示为“请继续处理”。
- 展示由已保存的路由 decision、原始 Web 用户来源、准确 Worker/Task/Role 与频道关联重建，不按助手正文猜测作者，也不插入新的用户或模型消息。原消息附件继续使用原来源入口。
- 每个拆分任务使用独立派单 ID；重复读取、分页与展示索引重建不重复。历史名称读取任务冻结的角色快照，专员改名不改写已发指令。
- Pilot 派单保持在正文中，不随普通过程播报折叠。会话就绪回调绑定当前渲染路由，避免子组件布局回调读取上一会话的被动更新引用。

## 检查

| 检查 | 结果 |
| --- | --- |
| `go test ./internal/ai ./internal/web -count=1` | 两个包通过 |
| 派单、频道、原作者及权限继承相关 race 回归 | 通过 |
| `go vet ./internal/ai ./internal/web` | 通过 |
| `python3 scripts/check_adk_runtime_boundary.py` | 通过 |
| `pnpm --dir web-agent check`、`test:frontend`、Vite 构建 | 通过，589 项前端测试通过 |
| 共享组件界面 fixture | 浅色桌面、360px 深色窄屏无横向溢出，@接收专员点击目标正确 |
| 已安装 macOS Lake Dev | 两边真实消息、@入口跳转与前台会话内容验证通过 |

永久回归覆盖同一条派单的两边身份、旧展示索引修复、原用户/任务不变、相同用户消息的独立拆单、补充要求、直接专员聊天、分页幂等、索引重建、改名后的历史快照和跨项目隔离。界面 fixture：`web-agent/web/test/fixtures/pilot-dispatch.html`。

## Dev 证据

使用 `scripts/build_lake_desktop.sh --dev --install` 安装签名 Lake Dev，来源为干净本地集成提交 `1aabdc251a7c522f473d3ebd3f8fda10d43c702a`，仅使用 `~/.lake-dev`。该集成提交保留此前 Dev 的 #162、#165、#166、#168、#170；本功能 PR 不包含这些分支。

现有项目恢复了 14 条 Pilot 派单/补充记录，数据库专员频道显示其中两条准确关联记录；两边消息 ID、正文、作者来源与任务关联一致，重复数为 0。点击 Pilot 正文中的 @数据库专员进入对应角色频道，前台显示 Pilot 指令及原回复。

更新前后逐表哈希核对：原始 Web messages/superagentInputs、canonical events/decisions、native operations/approvals 均未变化。没有重新执行数据库或 MCP 查询，先前 Pilot 统一权限和项目全局 MCP 继承配置保留。

未覆盖 Windows 和原生最小窗口尺寸；360px 检查使用同一 React 组件的浏览器 fixture。后台窗口渲染受 WebKit 可见性调度影响，原生内容核验在前台完成。

## 兼容与回退

无规范数据库结构变更，无权限或任务执行语义变更。新增可选 Message.dispatch 字段，Web 频道展示索引新增 dispatch 类型，并修复原转贴用户消息的索引；原始用户消息不删除、不改角色、不更改正文。

回退旧 UI/后端时可从原始消息和规范路由重建 Web 频道展示索引（timeline 与 cursors）。不要清理用户消息、规范任务、操作、审批或安全账本来回退显示。
