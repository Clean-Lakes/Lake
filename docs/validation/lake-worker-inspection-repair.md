# Worker 主机检查与回复头像修复验证

2026-11-03，macOS arm64。基线 `2b233a4ad9d405e5b7bf4705359303b31bcde652`；最终执行代码和干净签名 Dev 构建为 **`65ec4fdec699c3af94f70ea160038bac8d3add45`**。后续仅补充本验证记录，没有改变被测代码。机器可读结果见 [JSON](lake-worker-inspection-repair.json)。

## 故障与最终行为

真实 Worker 在 `work_begin` 中省略 `asset_refs`，确认了空资源范围；激活步骤后才发现主机。此时 `inspect_host` 的旧终端路径属于 opaque 操作，受到历史未决写入限制；再给已确认的目标补资源也被范围冻结拒绝。账本中只有资源目录读取成功，没有实际服务器检查，不能将先前回复解释为巡检结果。

Worker 的首次上下文现在包含当前可见资源的别名、名称和类型，不包含连接或凭据；最多 256 行、32 KiB 数据预算。Worker 工具契约要求 `work_begin` 显式提供 `asset_refs`，遗漏时在确认计划前拒绝。无资源 I/O 的任务仍可显式传空列表；索引中的名称属于不可信数据，不能扩大授权，实际操作仍经过当前 Security 与目标绑定检查。

受管 `inspect_host` 使用已有注册的 `process_snapshot` 固定诊断：编译并冻结命令、绑定当前连接版本、经过原操作许可和固定读取证据校验，通过受限 SSH 通道运行，不创建交互终端。SSH 目标缺少系统登记或配置已过期时明确拒绝，不回退到自由 Shell。普通旧工具说明和提示金样保留，新说明只进入 Worker 工具目录。

专员自己的最终回复使用 `message` 卡片，原身份栏只覆盖 `text` 卡片；现两者都显示同一角色头像和名称，沿用气泡外侧头像布局。

## 本地检查

| 检查 | 被测代码 | 结果 |
| --- | --- | --- |
| `go test ./... -json -count=1 -timeout=10m` | `65ec4fde` | 1,946 项测试/子测试、11 个包通过，退出 0 |
| `go test -race ./internal/ai ./internal/security -run 'TestSecurity(InspectHost\|Fixed\|ManagedSSH)\|TestSuper(Worker\|FirstPlan)\|TestWork' -json -count=1 -timeout=5m` | `65ec4fde` | 57 项、2 个包通过，退出 0 |
| `go vet ./...` | `65ec4fde` | 通过 |
| `python3 scripts/check_adk_runtime_boundary.py` | `65ec4fde` | 通过 |
| `pnpm --dir web-agent check`、`pnpm --dir web-agent test:frontend` | `32722df8`；其后前端未变化 | 类型检查及 570 项测试通过 |
| `scripts/build_lake_desktop.sh --dev --install` | 干净 `65ec4fde` | 成功，应用与后端 `codesign --verify --strict` 通过；应用同时使用 `--deep` 校验 |
| `git diff --check` | 最终代码 | 通过 |

新增回归通过真实 loopback SSH fixture 验证固定 `/bin/ps -eo pid,ppid,pcpu,pmem,comm` 派发、原许可归属，以及读取后仍保留旧 unknown 操作和写入阻断。另验证缺少 OS 登记时拒绝、拒绝额外 Shell/终端/环境参数、资源索引不泄露连接信息且受可见范围及字节预算限制、遗漏资源时不能进入计划确认。前端覆盖 `text/message × running/completed` 四种专员自身回复。

首轮完整检查发现修改通用 `inspect_host` 说明会改变旧提示金样；已撤回通用说明修改，将受管说明限定到 Worker，并在最终 SHA 重跑完整检查通过，没有更新金样来掩盖差异。

## Lake Dev 实测与边界

- 使用固定 `~/.lake-dev` 和 `~/Applications/Lake Dev.app`，正常停止内核后安装，再冷启动；恢复原项目，仍显示 135 个资源，执行侧栏默认收起。
- 原专员自身会话中的最终 `message` 回复已显示角色头像和名称，头像位于灰色气泡外；原生窗口、浏览器浅色 1280px 与深色 600px 均实看通过。窄窗文档宽度为 600px，无横向溢出，消息编辑器可获得键盘焦点。
- 根据用户本轮明确提供的 Linux 信息，通过既有 command-targets 管理 API 登记原 SSH 资源，读取确认 `State=ready`、`OS=linux`、`Revision=1`、连接版本一致、启用状态为真。未提供服务单元，保留 `Services=[]`，只配置已有 `disk_usage/process_snapshot` 诊断。
- 真实 Dev 的 93 条无安全描述的历史 unknown 操作，在安装、重启和配置前后，对 `id/session_id/tool/risk/status/handle/result` 排序投影计算的 SHA-256 均为 `9540501386ee5c60b1d27425ad0ccabb52d6718a4d64a3973b65e703e8409cd5`。没有清理未知结果、解除写限制或将旧操作改成成功。
- 原失败目标保留其失败记录及原冻结范围，不在已确认任务上追加资源或自动重放。后续检查需新建正确绑定目标的计划并走既有宿主确认。**本轮没有对真实远端运行新的巡检，没有宣称服务器或具体服务健康，也没有代替用户验收。** 固定读取的真实传输由 loopback SSH 回归覆盖。
- 既有大 Web chunk 和 Swift 构建参数弃用警告仍存在，不阻断构建。当前修复不启用 Memory V2、不完成整体 Super-agent 计划中的其余未交付项。

原始日志与截图仅在本机 `/tmp/lake-worker-*`，可能被系统清理；未提交真实连接配置、令牌或项目截图。安装后端 SHA-256：`0dd4906dce38019883fa53277da8fa934ced26b3d0ed25d584122e8ac0e8be06`。

## 集成与回退

独立 `codex/worker-recovery-avatar` 分支创建 PR 到 `develop`；日常 PR 无自动 CI，本记录只陈述上述本地结果。合并仍需本次 PR 的用户明确授权，没有生产安装、发布或保护分支直推。

没有数据库迁移或历史账本改写。代码需要回退时通过后续 PR 撤销本次修改并重建签名 Dev；不要降级到不支持既有 Security 迁移收尾格式的历史内核。Linux 目标登记是独立现有配置，如需停用应通过带当前 revision 的正常管理动作执行，不直接改 SQLite。
