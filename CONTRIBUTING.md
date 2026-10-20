# Lake 开发规范

本仓库采用 **功能分支 → PR → develop → 发布 PR → master**。`develop` 是长期开发集成分支，`master` 是生产分支；两者均禁止直接提交、推送或绕过 PR 合并。代码、修复、文档和配置修改都从最新 `origin/develop` 创建独立分支，通过 PR 进入 `develop`，先在 **Lake Dev** 累积并验证。

开始工作前必须阅读 [分支与发布规范](docs/development-workflow.md)；AI 同时遵守根目录 [AGENTS.md](AGENTS.md)。创建 PR 不等于获准合并，只有用户明确授权后才执行对应合并。生产合并和发布分别需要明确授权。

## macOS 本地联调

需要 macOS 13+、Apple Silicon、Go 1.26.6（以 `go.mod` 为准）、Node.js 24.14+、pnpm 10.33.4、Swift 5.9+ 和 Xcode Command Line Tools。第一次构建先配置持久代码签名身份：

```sh
scripts/setup_lake_signing.sh
pnpm --dir web-agent install --frozen-lockfile
```

以后从仓库根目录构建并安装 Dev：

```sh
scripts/build_lake_desktop.sh --dev --install
open "$HOME/Applications/Lake Dev.app"
```

构建脚本先调用 `scripts/build_lake.sh` 生成**已签名**的 `bin/lake`，再构建和签名 Dev 应用。缺少 `Lake Local Development Code Signing` 身份时应停止构建并运行一次签名设置脚本，不能改用未签名二进制。构建产物在 `dist/macos/<版本>/arm64/dev/`，安装位置为 `~/Applications/Lake Dev.app`。应用会启动自己的 Go 服务并选择本机空闲端口；不要另外启动一个服务来驱动这个窗口。

已运行 Dev 时，安装新包后先正常退出 **Lake Dev**，再打开上面的应用路径，确保加载新进程。不要退出或重启正式版 Lake。Dev 标题旁有 `DEV` 标记；模型和项目配置从独立目录读取，首次启动为空是正常现象。

| 项目 | 本地联调 | 正式版 |
| --- | --- | --- |
| 应用 | `Lake Dev.app` | `Lake.app` |
| Bundle ID | `com.cleanlakes.lake.desktop.dev` | `com.cleanlakes.lake.desktop` |
| 安装位置 | `~/Applications/Lake Dev.app` | `~/Applications/Lake.app` |
| Home / 凭据 | `~/.lake-dev/` | `~/.lake/` |
| Web 数据 | `~/.lake-dev/web-agent/` | `~/.lake/web-agent/` |
| 构建参数 | `--dev --install` | `--install` |
| 自动正式版更新 | 关闭 | 开启 |

Dev 忽略正式版的 `LAKE_HOME`、`LAKE_WEB_DATA_DIR` 和 `LAKE_WEB_TOKEN`。确需覆盖 Dev 路径时仅用 `LAKE_DEV_HOME`、`LAKE_DEV_WEB_DATA_DIR` 或应用的 `--lake-home`、`--lake-data`，并确保目标**不指向** `~/.lake` 或正式版的数据目录。不要把正式版的密钥文件复制或链接到 Dev。Magpie 的常规 Lake 插件对接 `~/.lake`；联调时从 [插件仓库](https://github.com/Clean-Lakes/magpie-agent-lake)单独安装 `lake-dev.agent.js`，它使用 `~/.lake-dev/secrets/magpie-agent.json`，在 Magpie 中显示为 Lake Dev。

只开发 Go/Web 而不打开桌面应用时，先通过 `scripts/build_lake.sh` 构建签名二进制，然后使用另外一个专用目录和端口，避免和两个桌面应用争用数据目录：

```sh
bin/lake web --home "$HOME/.lake-dev-cli" --port 4182 --open
```

## Windows 本地联调

Windows 本地联调使用 `python3 scripts/build_lake_windows.py --dev`，安装 `dist/windows/<version>/x86_64/dev/` 下的 Dev 包。程序和快捷方式名为 **Lake Dev**，固定数据目录为 `%USERPROFILE%\.lake-dev`；更新只替换程序文件，保留模型、项目、会话和凭据。Dev 忽略 `LAKE_HOME`，隔离运行只使用独立的 `LAKE_DEV_HOME`，不能指向正式版 `.lake`。测试脚本的随机隔离 Home 仅用于自动化验收，日常使用应启动固定位置的 Lake Dev。

## 前端界面规范

新增或修改前端界面时遵循 [Lake 前端 UI 规范](docs/ui-guidelines.md)。表单下拉框统一使用 `AppSelect`，通用图标使用 `Glyph`，供应商品牌使用 `ProviderIcon`；同时验证键盘、深色主题和窄窗口布局。

## 提交和安全

- 提交前检查 `git diff` 与暂存区，只加入本次修改。分支提交后向 `develop` 发 PR；同步最新 `origin/develop` 并处理冲突。`develop` 和 `master` 都只能经 GitHub PR 合入，禁止本地 merge 后直接 push。
- 日常提交及指向 `develop` 的 PR 不自动运行 CI；必须记录本地验证命令、结果、Dev 提交和未验证项。评审意见处理完且用户明确授权后才能合并；没有 CI 不表示已测试通过。纯文档无需虚构应用测试。
- 自动验证仅在同仓库 `develop -> master` 的 PR 阶段运行，通过后才可合并；不在合并后的 master 推送重复跑。需要额外 CI 时明确手动触发。发布资产工作流沿用独立发布授权。
- 发布按批次进行：版本、发布说明和验证材料先经 PR 合入 `develop`，再由用户授权创建 `develop -> master` 发布 PR。生产合并完成后另经发布授权才运行发布脚本；不自动给普通 PR 发版本。
- Go 代码用 `gofmt`；前端遵循现有 React/Vite 代码组织；macOS 客户端沿用 Swift Package 结构。改动对应功能时更新说明和必要的验证记录。
- 不在代码、日志、截图、Issue 或提交中放模型 API Key、SSH 私钥内容。Lake 正常运行的凭据位于各自 home 下权限私有的 `secrets/`；只有显式执行已签名的 `lake secrets migrate` 才读取旧 Keychain 凭据。
- 本地联调只检查 Dev 应用和隔离数据。正式版构建、安装与发布按 [macOS 客户端说明](client/macos/README.md) 进行。

## Official ADK runtime

Interactive agents use official ADK Go v2.6.0 on Go 1.26.6, including direct stdio and scheduled workflows. Runtime ownership is in `internal/ai/adk_*.go`; the shared durable session store is `internal/agent/storage`. Preserve the existing provider/executor boundaries. Do not add another model/tool loop, import SDK internals, or restore a production Go fallback. Run `python3 scripts/check_adk_runtime_boundary.py` along with Go/race/vet and frontend checks.

See [runtime architecture and recovery](docs/experiments/adk-runtime.md) and [migration acceptance](docs/validation/lake-adk-runtime-final.json). Keep credentials out of SDK events, state, artifacts and test output. Use the signed build scripts and an isolated Dev home for integration. Unknown operations require reconciliation; clearing model context never clears the operation ledger or authorizes a retry.
