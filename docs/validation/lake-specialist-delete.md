# 专员右键删除验收

日期：2026-11-04。功能提交：`258428e8`。普通 PR 目标为 `develop`。

## 行为

- 右键侧栏专员，或聚焦后按 Shift+F10，使用共享菜单选择“删除专员”。确认框明确命名角色，默认聚焦取消；Escape 关闭并恢复原行焦点。
- 确认后按准确项目、RoleID 和资料 revision 持久保存退休状态，停止该角色当前、等待及待派发任务。当前正在查看的角色被删除时返回 Pilot；侧栏计数立即更新，旧轮询不会短暂恢复已删除行。
- 保留原角色与频道、Task/Worker、消息、证据和操作/审批记录。删除不撤销远端操作，也不清除 unknown 结果。同名的其他角色和其他项目不受影响。
- Pilot 列表与侧栏排除已删除角色；新派单、旧 role_key、补充、频道接单及 Worker 租约/派发重新检查退休状态。中途退出后由原恢复循环继续取消，不重放工具。
- 接口为经过现有宿主认证/来源保护的 `DELETE /api/projects/:project/superagent/specialists/:role`，携带准确 `revision`。缺失/非法版本返回 400，过期版本 409，跨项目/不存在 404；重复提交同一次删除幂等。

## 验证

| 检查 | 结果 |
| --- | --- |
| `go test ./internal/ai ./internal/web ./internal/agent/storage -count=1` | 完整测试退出 0；ai 147.342s、web 280.074s，storage 无测试文件 |
| 删除、频道停止/管理/迁移相关 `go test -race` | 功能分支通过；最终 Dev 集成重新通过，覆盖删除后的派发资格、同名/跨项目隔离、空闲专员、旧版 revision 0、幂等、重启和中断删除恢复 |
| `go vet ./internal/ai ./internal/web ./internal/agent/storage` | 通过 |
| `python3 scripts/check_adk_runtime_boundary.py` | 通过 |
| `pnpm --dir web-agent check`、`test:frontend` | 功能分支 588 项通过；保留已有候选功能后的最终 Dev 集成 589 项通过 |
| 签名桌面构建安装 | `scripts/build_lake_desktop.sh --dev --install` 成功，包含 Vite 构建 |
| 共享组件浏览器 fixture | 浅色桌面确认框、深色 360px 无横向溢出；右键、Shift+F10、Escape、默认取消焦点、原位失败和重试、删除后计数及返回 Pilot 通过 |
| 已安装 Lake Dev | 原生右键“发布专员”显示删除菜单；确认框目标、说明和默认取消正确；Escape 后返回原行，4 位真实专员保留 |

浏览器 fixture 使用实际 `PilotWorkspace`、共享菜单和 `SpecialistDelete`，仅 HTTP 删除响应为合成测试数据：`web-agent/web/test/fixtures/specialist-delete.html`。Dev 没有删除真实专员；真实后端删除、停止、保留记录及重启由临时数据库的 Go/HTTP 回归覆盖。Windows 和原生最小窗口未验证。

## Dev 来源与数据

已安装 Dev 来源为干净本地集成提交 `58e38d5ea608c49822deb5574ea1adae147be2e4`，仅使用 `~/.lake-dev`；保留此前 #162/#165/#166/#168/#170/#171 候选，不将它们纳入本 PR。安装后规范库 schema6，真实角色退休数为 0。

安装前后逐表哈希确认原始消息/输入、规范事件/决策及操作/审批未变。原 14 条 Pilot 派单与数据库专员的两条关联记录、统一权限、项目继承启用全局 MCP 和另外四个项目的设置保持不变。未重新执行任何数据库或 MCP 查询。

## 迁移和回退

schema5 → 6 只新增角色 `deleted_at`，迁移前沿用私有一致快照备份；schema3/4 的既有升级路径也进入 6。更新 storage reader guard，新 reader 接受 3–6，旧 reader 拒绝 6，避免忽略退休状态重新派活。

回退需停止新内核，恢复迁移前完整配套数据，或保持兼容 reader 向前修复。不要删除退休标记、角色、用户消息、任务、操作或审批账本来绕过版本保护。本功能不改变项目资源或操作权限。
