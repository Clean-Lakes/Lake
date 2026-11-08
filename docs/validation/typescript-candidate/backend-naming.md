# TypeScript 后端命名与历史兼容验证

日期：2026-11-07。项目自身的目录、构建、界面、提示词和公开协议统一使用 TypeScript／原生 Agent。真实 SDK 依赖名、原始版权与许可、固定来源、历史源码引用及旧数据读取标识保留在明确的集成边界，不代表另一种 Lake 后端身份。

## 源码与安装水位

- 独立功能分支：`codex/typescript-backend-naming`，基于 `origin/develop` 的 `406d043071b0305442e5c9f3a1c518d6b16cb59c`。
- 功能源码：`64ed398a0af4a3e6679c1b51e5ea312d633a5326`（包含首批实现 `b25acdb6`；后续仅补充 SDK 存储类型导出）。本记录及计划状态的后续提交只更新文档。
- macOS arm64 组合 Dev 源码：`31dba85b2df14bae737906f8fe257cd434b9be15`。本地 `codex/discovery-dev-validation` 同时保留 PR 190–194 的资源、恢复、并发、侧栏、Mini Box 和未读提示变更；未将这些 PR 合入 develop。
- 使用 `scripts/build_lake_desktop.sh --dev --ts-candidate --install` 构建并安装 `~/Applications/Lake Dev.app`。Bundle ID 为 `com.cleanlakes.lake.desktop.dev`，固定 Home 为 `~/.lake-dev`。
- 安装后端 SHA-256：`5e33fb26e8bb935d344ea8dd095224001d1bfcdb0249a2170128d4f862344770`。持久开发身份签名及 `codesign --verify --deep --strict` 通过；包内运行目录为 `lake-runtime`，版本及原生窗口标题为 `Lake Dev · TypeScript`。

## 自动检查

使用固定 Node 24.14.0。以下没有依赖 develop 自动 CI。

| 检查 | 独立功能分支 | 本地组合 Dev |
| --- | --- | --- |
| `python3 scripts/check_backend_naming.py` | 0 项违规，按分类报告允许的边界 | 0 项违规 |
| `python3 -m unittest discover -s scripts -p test_check_backend_naming.py` | 4 / 4 | 4 / 4 |
| `python3 scripts/prepare_typescript_runtime.py` | 固定归档摘要及上游原始源码逐文件核对通过 | 签名构建重复核对通过 |
| `node third_party/agent-sdk/node_modules/typescript/bin/tsc -p runtime/typescript/tsconfig.json` | 通过 | 通过 |
| `pnpm --dir web-agent check` / `build:web` | 通过 | 通过 |
| `pnpm --dir web-agent test:frontend` | 694 / 694 | 721 / 721 |
| `node --test runtime/typescript/*.test.cjs`（先运行 `node runtime/typescript/build.mjs`） | 118 / 118 | 133 / 133 |
| 在 web-agent 运行 `pnpm exec tsx --tsconfig web/tsconfig.json --test ../runtime/typescript/*.test.ts` | 72 通过、3 跳过 | 117 通过、3 跳过 |
| `node runtime/typescript/inventory.mjs` | 124 项，与当前前端一致 | 128 项，与组合前端一致 |
| `python3 scripts/check_typescript_parity.py --report` | `cutoverAllowed=false` | `cutoverAllowed=false` |
| Shell 语法、暂存差异空白、仓库 JSON 解析及原始许可证字节核对 | 通过，16 份原始许可文件未改 | 通过 |

跳过项为现有 Claude-Mem 外部集成：受管进程真实生命周期、显式启用的真实上游协议，以及真实 Claude-Mem 检索排序与遗忘验收。本批没有把这些跳过项算作通过，也不重新声明长期记忆质量或完整产品等价。

专项回归覆盖：私有新档案、已提交 WAL 复制、源档案保留、正常 checkpoint 后重复启动、迁移发布中断恢复、回退后分叉检测、双档案冲突、符号链接拒绝；真实 SDK 对话通过旧档案迁入后继续引用上一轮内容；旧 child/control 投影及资源归属保持，读取不改写原存储行、业务回执与权限输入。

API 清单补齐当前分层记忆的 6 个既有操作；没有新增功能等价认证。完整切换门禁仍阻止默认／生产后端切换。

## 本机 Dev 复核

先确认 Worker 和命令均无活动，再通过原生菜单停止内核并退出。对应用、两份会话数据库和原业务行摘要建立私有备份／基线后安装；未读取 Keychain、模型 API 密钥或 SSH 私钥内容。

- 新 SDK 档案权限为 `0600`。19 个 Session ID、315 条 message、725 条 part 以及所有 SDK 表行数与迁移前一致；保留的旧档案文件字节摘要未改变。
- 1155 条原消息、目标、操作、Worker 与命令记录在安装前后、原生浏览后逐行内容摘要均一致。没有提交新业务请求或恢复历史执行。
- 原生窗口显示 `Lake Dev · TypeScript`；原专员列表、历史任务、Mini Box 真实命令输出及结果证据可以打开。检查后关闭第三联并恢复原项目的 Pilot 对话与浅色主题。
- 安装后的 bootstrap 返回 `aiRuntime=typescript`、`backendRuntime=typescript`、`memoryEngine=layered`；旧会话的公开 `agentRuntime` 为 `typescript`，原存储选项不为改名而重写。

## 范围与回退

当前普通 Go 默认构建、生产安装与发布均未切换。Windows/Linux 原生包及其他平台的档案迁移未实机验证；本机采用 SQLite backup，不重命名活动 WAL 文件。

旧档案保留，不能把两份数据库简单覆盖或删除后合并。旧程序回退只读取其旧档案水位，新版写入不会反向同步；若回退产生新历史，下次迁回要求先核对分叉，不自动选择、覆盖或重放。源码和构建回退可使用私有备份应用；数据变更需先核对两份档案。

本命名 PR 应在前序 PR 合入后同步 develop，并按本地组合分支的处理，将目录重命名期间新增的运行时、测试和记录一并移动、更新引用与 SDK 绑定，再运行命名检查。Git 自动移动新增文件不足以替代这一步。
