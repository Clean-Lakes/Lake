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

回复过程中仍可输入消息、引用资源和附加图片/文本文件。点击“挂起消息”或使用发送快捷键，将消息加入当前会话的“待发送”队列；本轮正常完成后按顺序逐条发送。队列可编辑、移除、拖动排序，也可用上下按钮或排序手柄的方向键调整顺序。开始编辑会先暂停队列，保存后点击“继续发送”。有输入内容时，停止按钮和挂起按钮同时可用。

待发送队列保存在本机数据库，每个会话最多 20 条，刷新页面、切换会话后仍保留。消息开始发送时才进入对话记录，图片与文件附件、资源引用一起保留；发送前重新校验访问范围和模型图片能力。审批时等待当前轮次处理，手动停止、回复失败或服务重启后保留并暂停后续消息，点击“继续发送”才恢复；模型使用实际开始发送时的当前选择。

模型设置采用供应商列表和配置面板的双栏布局，可新增、编辑、启用、停用或删除供应商，并为每个供应商管理多个模型。Base URL、API 格式和密钥直接可见；模型条目可设置显示名称、上下文 tokens 和图片能力。保存后立即生效，聊天模型菜单按供应商分组，切换时使用对应供应商的接口和独立凭据，无需重启客户端。对话快捷键移到单独的“对话”标签页。

首次打开模型设置会自动保留已有单模型配置。供应商配置保存于 `~/.lake/web-agent/providers.json`，密钥只存于 `~/.lake/secrets/` 的私密文件，不会回传页面；密钥输入留空保持该供应商已有值，点击“清除”并保存才会删除。可按供应商测试连接或获取模型列表，所有未保存草稿在切换供应商时保留。“使用”模型会先保存当前供应商，再立即切换模型。

资源列表“新建 → 从文本导入”可选择任意扩展名的文本文件或粘贴配置，预览并勾选后导入。聊天“文件”按钮可附加文本，也可直接让 AI 读取本机文件路径并导入；AI 通过 `preview_resource_import` 和 `import_resources` 使用同一套校验，遵循会话的文件读写权限。支持 JSON、CSV/TSV、HexHub 导出，以及通过已配置模型识别 SSH 配置、Markdown、YAML 和文字说明；文本编码支持 UTF-8、带 BOM 的 UTF-16 与 GB18030，每个文件最多 1 MB。名称、地址、端口和分组会显示在预览中，私钥和模型 API 密钥不会进入模型输入或预览；凭据保存在私密目录。缺少登录信息的条目会提示补充，已有连接跳过，导入后资源与目录立即刷新，当前 AI 轮次也可使用新资源，无需重启客户端。资源绿点仅表示已连接的交互终端。

[运行与开发](web-agent/README.md) · [Go AI 接入](docs/hexhub-ai/README.md) · [迁移计划](plan/refactor-go-server-1.md) · [发布验证](docs/validation/lake-go-server.md)

仓库保留 `agent/`、旧桌面/ZCode 客户端和 `legacy/web-agent/` 作为历史实现。它们不参与当前 Go 发布入口；旧 grants/tasks/workflow 命令与历史 Agent 数据不自动转接或导入新工作台。旧版文档见 [TypeScript Agent v0.0.1](docs/lake-ts-agent-v0.0.1.md)。

持续终端内可打开“终端 AI”，按资源恢复独立历史并明确绑定当前 shell；支持 Bash/Zsh/Fish hooks、cwd/命令块上下文、同项目终端采用授权及资源访问记忆。停止本轮、Ctrl-C 中断和关闭终端分别处理，断线读屏标记历史来源。[补齐与验收](docs/validation/lake-hexhub-terminal-parity.md)

本轮逐项复核补齐终端面板图片/上下文引用、实时采样时间及授权永久撤销，并拒绝终端与资源不匹配配置。[24 步验收清单](docs/validation/lake-terminal-plan-step-audit.md)
