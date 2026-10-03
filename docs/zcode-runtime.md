# 原生 LAKE 运行时

当前客户端使用 `third_party/zcode/packages/desktop` 的 Electron Main、Host、preload 和原生 React 页面。签名的 `bin/lake` 默认把参数传给源码构建的原生 CLI，不进入此前的 LAKE Agent 或运维工作流执行器。Wails 源码保留为历史参考，不参与新的桌面构建。

LAKE 数据面板通过 `useLakeData` → `IPlatformService` → 受校验的主页面 IPC → 独立 `lake-data.cjs` 读取湖、资源、湖志和关联表。数据进程只打开 SQLite/私有文件，不构造 Agent、WorkflowRunService 或 WorkflowSchedules。返回资源仅含公开地址与名称，不返回凭据引用或私钥。

原生 Agent 经原有 MCP 传输和权限机制使用 `lake_context`、`lake_resources`、`lake_journal` 三个只读数据工具。工具范围来自显式工作空间关联，调用时重新检查；工作空间改绑后拒绝旧会话的数据调用。全局 Skills 的说明不是当前湖的资源或执行授权。

项目关联后，湖面板复用原生 SavedWorkflowsSection 列表、编辑、运行、历史及产物组件。项目工作流来自工作空间 `.lake/workflows`；关联的全局工作流来自 `~/.lake/workflows`，运行落点只提供该湖关联的项目。SQLite 只保存关联元数据，原生文件、运行 journal、权限与会话是工作流的权威来源。湖志展示 LAKE 数据操作记录，原生执行记录通过工作流历史查看。

所有运行目录使用 LAKE 命名空间：全局 `~/.lake`、项目 `.lake`、Electron `Application Support/LAKE`。设置 `LAKE_HOME` 后，数据、原生配置、会话、日志、全局工作流和 Electron 状态使用指定根。原生协议标识和包名保留兼容，`.zcode-plugin` 仍是扩展清单格式；它不是正版用户数据目录。OAuth/deep link 使用独立 `lake://`。关闭上游客户端自动更新，避免安装正版产物覆盖本分支。

打包复用原生运行资产准备流程，携带源码构建的本地和远程运行组件、原生插件、工具与许可。远程资产的 manifest 哈希保留，应用与本地可执行代码使用持久开发签名；该签名适用于本机开发安装，不等同于 Apple 公证发行。

Main、Host 和原生 Scheduler 的 ESM 包提供 CommonJS 加载桥。包内 Agent、公开 CLI 与远程运行资产携带独立依赖目录和内置 Provider JSON；打包验收在源码目录外执行，检查原生存储握手、CLI TUI 模块加载和 Scheduler 启动，避免开发目录掩盖漏打包依赖。

开源上游 `packages/zcode-cua` 是 API 兼容的占位包，Computer Use 调用会明确返回不可用。这里保留上游实现及边界，不宣称提供正版客户端的专有 Computer Use 能力。
