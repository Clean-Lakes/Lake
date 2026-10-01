# ZCode 运行时

当前桌面前端仍为 `client/desktop/frontend`。Wails 通过 NDJSON 调用签名的 `bin/lake serve`，Go 只启动固定 Node 24.14.0 与源码构建的 `bin/zcode/zcode.cjs lake`，并处理原生文件/媒体展示。

`@zcode/lake` 内的 TypeScript 服务负责原有 SQLite 数据层、私有凭据、资源授权、审批、运维工作流和湖志。它向原生 Agent 暴露带湖范围的 MCP 工具。ZCode 原生权限处理代码工具；LAKE 工具在运维边界再次核对目标身份、授权和审批。

ZCode app-server 负责持续会话、历史、上下文压缩、工具、子 Agent 与检查点。原有 LAKE 对话在首次建立原生会话时通过原生历史导入契约导入；后续恢复使用 ZCode 持久化会话。原有 SQLite 历史继续可读。

本机文件索引、Git 和 PTY 使用 `@zcode/services/lake-host` 的原生服务。远程工作区使用 ZCode 的 SSHBackend、部署和远程服务，要求已授权主机与工作区，以及已有可信 known_hosts 记录。原生终端实时输出，不从提示符推断命令成功。

原生 Skills、插件、MCP、Hook 信任及通用自动化使用 ZCode 配置和实现。LAKE 中的原生服务共享 `~/.lake/zcode-runtime/storage`，每个会话由 ZCode 独立持久化，扩展面板与 Agent 使用同一份原生扩展存储。旧 LAKE 扩展记录保留作历史，不自动转换为原生执行授权。保存的专员指令适配为原生 Agent Markdown；原生 Agent 负责执行生命周期。

专员表单适配名称、说明、指令与启用状态。旧的独立模型、工具白名单、轮数与专员资源范围保留在历史配置中；原生任务使用当前会话的模型与权限，LAKE 工具继续核对当前会话的资源授权。停用的配置不会生成原生 Agent 文件。

构建：`scripts/build_lake_desktop.sh`；成功后使用输出的 `.app` 路径启动。所有 macOS 构建由持久的 `Lake Local Development Code Signing` 身份签名。

远程运行资产只打包源码构建的 `zcode-server.cjs` 和版权声明，不携带旧的 TypeScript 编译产物或同步副本。
