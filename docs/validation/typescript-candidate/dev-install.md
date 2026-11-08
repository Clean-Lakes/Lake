# TypeScript Dev 覆盖安装验证

命名说明：本文路径和协议名称已映射到当前 TypeScript 后端；历史提交 SHA 保留，原始命令与输出以对应提交为准，此映射不表示重新执行历史验证。


2026-11-05。用户明确要求：“我要的是 TypeScript 后端的 Dev 版本 覆盖现有 Dev。”按该新增授权构建、覆盖安装并启动 Lake Dev；这是未完成全量迁移的 Dev 预览，不代表完整功能或正式版切换验收通过。

- 已安装、实际启动和验证的源码 SHA：`beecd89d01b94195909b36279be5df4e34a33a39`，构建时工作区干净。
- macOS / Apple Silicon，Lake Dev 0.3.27；Agent SDK v3.17.2 / Node 24.14.0。
- 命令：`scripts/build_lake_desktop.sh --dev --ts-candidate --install`。
- 覆盖位置：`~/Applications/Lake Dev.app`；Bundle ID 仍为 `com.cleanlakes.lake.desktop.dev`。

## 真实安装与启动结果

| 项目 | 结果 |
| --- | --- |
| 旧 Dev 停止 | 从应用菜单执行“停止内核并退出”，确认应用退出、后端 preflight 通过。未强杀 PID 或删除占用记录。 |
| 回退备份 | 安装前保留旧 Dev 应用，并对已停止的 `.lake-dev` 建立 APFS copy-on-write 快照，位于 `~/Library/Application Support/Lake Dev/backups/<日期>-before-typescript-*/`。普通全量复制因空间不足未完成，其本次临时副本已移除；最终快照复制成功。备份目录私有。 |
| 打包与签名 | 签名 Node SEA、React 页面与许可随 Dev 包携带；原生和内嵌后端签名、包内来源 SHA/后端摘要校验通过。 |
| 运行类型 | 包内 `LakeBackendRuntime=typescript`；实际进程 `/api/bootstrap` 返回 `backendRuntime=typescript`、`aiRuntime=typescript`、`upstreamVersion=3.17.2`。不是连接旧 Go 后端。 |
| 运行发现 | 认证 lifecycle 的 PID 与 runtime.json 一致，Home 为 `.lake-dev`，data 为其 `web-agent`，`draining=false`。原生客户端已加载页面。 |
| 原生界面 | 观察到窗口 `Lake Dev · TypeScript` 和 Lake 原 UI，模型已配置、初始项目列表为空；持续终端未迁移的提示仍显示。未将其视为全功能通过。 |
| 模型配置 | 4 个现有 Dev 供应商公开配置一次性导入 TS 库，当前模型已配置。凭据保留同一 Dev Home 的私有文件引用，不复制正式凭据或读取 Keychain。 |
| 旧数据 | 安装启动后旧 `lake-web.sqlite` SHA-256 与安装前一致，旧 providers.json 与快照逐字节一致。旧项目/会话尚未迁入 TS 库；旧任务、审批、安全/记忆账本不导入为可执行状态、不自动重派。 |
| 普通入口 | 仓库默认 `bin/lake` 构建前后摘要一致；正式应用和正式 Home 未切换。 |
| 安装资产 | `Lake-0.3.27-macos-arm64-dev-typescript.zip` 与 `.dmg` 的 SHA-256 检查通过。 |

## 对应回归

- TS 严格类型检查与真实 Agent SDK HTTP 模型夹具 **9/9** 通过；新增同 Dev 模型导入、私有引用、重启不复活已删除配置、旧数据库不改写，以及 Dev opt-in 不允许正式 Home。
- Python Dev preflight / 来源检查 **16/16** 通过；shell 语法和 `git diff --check` 通过。
- 原生 `LakeUpdateTests` 通过，包括下载/取消、环境目录隔离、更新清理和发布策略；新增 Dev 可选择 TS、正式版固定 Go 的断言。实际原生 Dev 构建和签名通过。
- `scripts/build_lake_desktop.sh --ts-candidate` 在没有 `--dev` 时预期拒绝；没有放开正式版入口。
- `python3 scripts/check_adk_runtime_boundary.py` 通过；API 清单仍为 118 项，完整等价门禁仍未通过。
- 本轮未修改 React 文件；603 项前端测试的既有证据见[前一阶段记录](README.md)。未重复声称新的全量 frontend/Go/race/vet 或 Windows 验收。

## 剩余范围与回退

终端、Pilot/专员、任务/安全/记忆等完整迁移和旧项目/会话可执行迁移仍在计划内。本次安装仅满足用户新增的 Dev 预览覆盖要求。默认/正式版完整切换继续受全量等价门禁约束，PR 保持草稿，不合并、不发布。

回退时先通过 TS Dev 菜单正常停止内核，再从上述私有备份恢复旧 Dev 应用。旧 Go 数据库保持原样；TS 新数据保存在独立命名的 SQLite，不自动反向同步为 Go 会话。
