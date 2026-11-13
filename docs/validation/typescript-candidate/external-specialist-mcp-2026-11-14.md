# 外部研发 Agent 经 MCP 给专员发指令 · 验收记录

日期：2026-11-14。tested SHA：`0660e9ed…` 之后追加 `1b947a7e`（网关状态门按公共指令 ID 解析）、`236be099`（任务行外部 Agent 徽标）；最终签名二进制 SHA-256：`a766ab529ec1c84aef99232f6ac6ed25946401fed8ece776a5f019f343e9bd58`（源码含徽标提交）。

## 行为与边界

`--mcp-specialist` stdio 入口为外部研发 Agent 提供每个专员的 MCP 工具面：`send_instruction`（`client_request_id` 幂等）、`wait_instruction`（≤600s）、`get_instruction_status`；共享模式另有 `list_specialists`，单专员模式不暴露目录工具并拒绝其他 RoleID。指令复用专员频道人工输入链路：InputEvent（带 `external:{kind:'mcp'}`）→ Pilot 路由 → route_work → Worker → 署名报告回投频道；Lake Security、operation permissions 与审批确认照旧在 Lake 界面完成。网关凭据是独立受限令牌（`secrets/mcp-gateway.json`，0600 私有文件、constant-time 校验、可限定专员、删除立即失效），与 UI 会话令牌互不通用；stdio 进程只访问回环后端（非回环 origin 拒绝）。设置 → Agent 页签可创建/删除凭据并复制完整 MCP 命令；频道任务行显示"外部 Agent"徽标（worker 投影新增 `sourceExternal`）。

## 自动验证

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| TS 类型 | `tsc -p runtime/typescript/tsconfig.json`；web `tsc --noEmit` | 通过 |
| TS 源码全量 | `tsx --test runtime/typescript/*.test.ts` | 317 项：313 通过、4 条件跳过（既有可选场景） |
| 新增单测 | `gateway.test.ts`（4）、`mcp-stdio.test.ts`（4） | 通过：凭据生命周期/constant-time/越权/篡改文件、回环校验/角色绑定/等待回路/令牌歧义 |
| HTTP 端到端 | `node --test runtime/typescript/*.test.cjs` | 264 项：258 通过、6 条件跳过；`gateway.test.cjs` 5 项覆盖全链路、幂等/冲突、认证矩阵、吊销、停止、参数校验 |
| 前端全量 | `pnpm --dir web-agent test:frontend` | 820/820（含 3 项新徽标/卡片回归） |
| 构建 | `pnpm --dir web-agent build:web`；`node runtime/typescript/build.mjs` | 通过（保留既有 chunk 提示） |
| 架构边界 | `scripts/check_adk_runtime_boundary.py`；`scripts/check_backend_naming.py`（含 `.gitignore` 会话目录白名单与测试更新） | 通过 |
| 签名构建 | `scripts/build_lake.sh --typescript`；`codesign --verify --strict bin/lake` | 通过 |

## 真实模型与界面（隔离实例）

签名后端运行于临时 Home + 随机 loopback 端口；仅在该临时 Home 配置真实模型（Dev 的 DeepSeek 凭据经私有文件读取，未打印、未写入记录或仓库），未导入业务任务/资源连接/权限/Memory。真实 Pilot 创建"数据库专员"后：

- 通过 `bin/lake --mcp-specialist --home <tmp> --role <roleId> --token-id <id>`（签名 SEA 二进制）以标准 MCP stdio 协议握手：`initialize` → `tools/list` 返回单专员模式 3 个工具（无 `list_specialists`）。
- `send_instruction("检查生产数据库健康状态…")` 建立真实指令；真实 Pilot 路由创建业务任务，真实 Worker 执行 `date` 与 `df -h` 只读查询，署名报告回投频道；`get_instruction_status` / `wait_instruction` 收到 `replied` 与完整报告文本（时间、460Gi/84Gi 磁盘余量、"未改动任何文件或配置"）。
- 同 `client_request_id` 跨后端重启重放返回同一指令；内容变化返回 409。
- 删除网关凭据后，同一 MCP 进程的下一次调用立即 401（"需要 Lake 网关凭据"）。
- UI（Ego Browser，隔离实例）：频道任务行显示"外部 Agent"徽标（浅色/深色/390px 窄窗）；设置 → Agent 页签网关卡片展示凭据、限定专员与完整命令（浅色/深色）。截图见 [external-specialist-mcp/](external-specialist-mcp/)。
- 后端路由期间发现并修复两处公共指令 ID（消息 ID）解析遗漏（`0660e9ed`、`1b947a7e`），修复后全部复测通过。

## 未验证项

- 原生 Lake Dev 组合安装（`build_lake_desktop.sh --dev --install`）与真实 Claude Code/Codex 客户端手工接入：本机 Codex 模型代理当前无响应，改用 DeepSeek 完成真实模型验证；桌面安装来源核对与窄窗目视仍在隔离 Web 实例完成，未做原生安装验收。
- Windows/Linux 平台实测；`wait_instruction` 在长任务（>10 分钟）下的多轮轮询行为仅由单测与 600s 上限保证。
- 未触发 CI、未合并 PR、未发布。

## 回退

回退本功能源码即可停止对外 MCP 入口与网关路由；保留已写入的指令事件、任务与报告记录，原任务/Memory/验收不改写。删除 `<Home>/secrets/mcp-gateway.json` 即吊销全部外部访问。
