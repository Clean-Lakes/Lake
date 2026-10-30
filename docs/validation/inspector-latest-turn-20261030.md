# 最新执行详情与手动历史验收

- 基线：`origin/develop` 的 `f70eed4831e0bfa4d9c119c7b3113ba522e957aa`，包含已合并 #126 / #127。
- 已测试代码及安装来源：`6ec28dd20ec65af5d1aecdb7cda6da92027e1f5e`；本记录后续提交仅改文档。
- 平台：macOS / arm64，Lake Dev 0.3.22，独立 `~/.lake-dev`。正式版未变更。

## 行为

顶部入口重新打开默认跟随最新用户轮次，只保留页签偏好。新轮次暂无操作时显示“本轮尚无执行记录。”，不回退到先前操作或 Pilot 任务。默认跟随的新操作随快照更新；显式打开历史耗时、任务或步骤则固定历史目标。重新从顶部打开恢复最新跟随。

Pilot 任务必须属于最新用户轮次，或具有当前 rootTurnId 绑定的本轮 AgentRun；新消息已到达、旧 AI 快照尚未更新时，不借用旧任务。Pilot 计划切到普通新轮次时同步切换执行页及空状态。

## 验证

- `pnpm --dir web-agent test:frontend`：554 项通过，0 失败。
- `scripts/build_lake_desktop.sh --dev --install`：类型检查、Vite 构建、后端签名、原生构建、Dev 安装均通过；保留现有大 JS chunk 和 Swift 构建系统弃用警告。
- `codesign --verify --deep --strict ~/Applications/Lake\ Dev.app`：通过。
- 安装来源 clean，SHA 与上述代码一致；安装后端 SHA256 匹配 build-origin，重启后实际提供的 JS/CSS 与本次 dist 完全一致。
- 浏览器真实 App + 虚构快照夹具 `test/fixtures/inspector-latest.html`：先打开旧轮耗时，F6 新轮到来仍固定旧轮；关闭后顶部重开显示新轮空状态；F7 新操作出现只显示“最新任务资源”；F8 第三轮到来恢复空状态。Escape 关闭和入口焦点恢复、重新打开均通过。
- `?pilot` 夹具：打开 Pilot 计划后，F6 普通新轮自动改为执行页及空状态；F7 展示最新操作，未残留旧计划。
- 模型测试覆盖普通模式、旧 AI 快照滞后、当前 root 绑定的 Pilot 延续、历史 attempt 原计划及跨会话隔离。
- 实际 Lake Dev 已在无运行中会话时重启；原生窗口顶部打开显示“当前执行”和本轮操作，旧 Pilot 计划未出现，Escape 可关闭。未为验收发送真实模型消息或操作集群/数据库。

## 范围和限制

仅改检查栏选择和展示；不改工具、凭据、执行权限、任务调度或持久化格式。自动新轮次和 Pilot 交接通过虚构事件验证，实际 Dev 验证加载及打开/关闭。无新的布局或颜色变更；未重新执行所有窄窗和主题视觉矩阵。没有运行 develop 自动 CI，未操作生产。回退可通过后续 PR revert 本次代码提交。
