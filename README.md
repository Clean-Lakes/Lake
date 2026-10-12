# Lake

macOS 客户端：运行 `scripts/build_lake_desktop.sh` 生成原生应用与 DMG/ZIP，`--install` 安装到 `~/Applications/Lake.app`。右上角更新图标检测 `master` 的正式 Release，点击后自动下载、校验、替换并重启，失败回滚。[客户端与发布说明](client/macos/README.md) · [下载安装包](https://github.com/Clean-Lakes/Lake/releases)。

Lake 是 Go 运维 Agent 后端和 React 工作台。Web 服务、SQLite 会话存储、SSH/PTY 终端管理与 AI 工具执行均在 Go 中运行；签名的 `bin/lake` 内嵌前端，分发和启动无需 Node.js。

```sh
scripts/build_lake.sh
bin/lake web --open
```

访问 `http://localhost:4177`。Node.js/pnpm 只用于 React 构建；已有前端产物时可使用 `LAKE_REUSE_WEB_ASSETS=1 scripts/build_lake.sh`。macOS 必须使用持久 `Lake Local Development Code Signing` 身份签名，缺少身份先运行 `scripts/setup_lake_signing.sh`。

工作台按项目管理会话、本机/SSH/数据库/Docker/Redis 资源，支持持久终端、人工接管、流式 AI、工具确认、思考过程、三种场景、图片、上下文压缩与提示词预设。聊天中旧操作按原轮次排列，不再显示折叠终端汇总条。

数据默认位于 `~/.lake/web-agent/`，模型和 SSH 凭据在 `~/.lake/secrets/` 私有文件内。Go 读取现有 Web SQLite 和 AI 状态；升级表结构前创建一致性备份，重启不自动重放命令。正常操作不访问 Keychain，旧凭据迁移必须显式运行签名 `lake secrets migrate --manifest FILE`。

[运行与开发](web-agent/README.md) · [Go AI 接入](docs/hexhub-ai/README.md) · [迁移计划](plan/refactor-go-server-1.md) · [发布验证](docs/validation/lake-go-server.md)

仓库保留 `agent/`、旧桌面/ZCode 客户端和 `legacy/web-agent/` 作为历史实现。它们不参与当前 Go 发布入口；旧 grants/tasks/workflow 命令与历史 Agent 数据不自动转接或导入新工作台。旧版文档见 [TypeScript Agent v0.0.1](docs/lake-ts-agent-v0.0.1.md)。

持续终端内可打开“终端 AI”，按资源恢复独立历史并明确绑定当前 shell；支持 Bash/Zsh/Fish hooks、cwd/命令块上下文、同项目终端采用授权及资源访问记忆。停止本轮、Ctrl-C 中断和关闭终端分别处理，断线读屏标记历史来源。[补齐与验收](docs/validation/lake-hexhub-terminal-parity.md)

本轮逐项复核补齐终端面板图片/上下文引用、实时采样时间及授权永久撤销，并拒绝终端与资源不匹配配置。[24 步验收清单](docs/validation/lake-terminal-plan-step-audit.md)
