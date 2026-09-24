# Lake 会话与 ZCode 数据隔离

## 产品规则

- Lake 的本地任务、会话正文、设置、湖资源和窗口标签属于 Lake 数据域。启动 Lake 不读取或迁移 ZCode 的历史任务、会话或项目列表。
- Lake 与 ZCode 可以同时运行；同一路径的工作区在两个产品中仍是不同的会话集合。旧 ZCode 数据保留原位，不删除、不自动导入。
- 开发版 Lake 与正式版 Lake 的 Electron 用户数据分开；两者也不与 ZCode Dev/ZCode 共用用户数据。
- 用户显式配置 Lake 数据目录时，任务索引和 Agent 会话库跟随该目录。不得由旧 ZCode 设置覆盖 Lake 数据目录。
- Lake 默认持久化根固定为 `~/.lake`。Main、Host、内嵌 Agent、模型配置、凭据、设备标识、CLI 日志和 Computer Use 运行文件都必须优先使用这一根目录；不得因为内部环境变量仍沿用 `ZCODE_*` 命名而写回 `~/.zcode`。
- Electron 正式版 `userData` 使用 `~/Library/Application Support/Lake`，开发版使用 `Lake Dev`；应用 ID、单实例锁、窗口状态和 Chromium session 均不得与 ZCode 共用。
- 数据目录迁移只允许在旧、新 Lake 根之间复制 `.lake/v2`，不得把目标写入 `.zcode/v2`。现有模型供应商一次性只读导入规则由 `vendor-config-removal.md` 单独约束，导入后权威文件仍只在 `.lake`。

## 状态所有者与接口

- `packages/services/src/paths.ts` 拥有 Lake 服务数据根（`{dataBaseDir}/.lake`），任务索引和资源目录从这里派生。
- `settingService` 拥有 Lake 设置文件（`{desktopHome}/.lake/v2/setting.json`）。Desktop Main 观察同一文件。
- Desktop Main 拥有 Electron `userData` 身份，以及 Host 启动环境；Host 传递 Lake 专属 Agent 会话库绝对路径，CLI/runtime 拥有会话正文。
- Renderer 侧栏只渲染 Host 和窗口标签存储提供的 Lake 数据，不通过标题、路径或 UI 过滤猜测产品来源。

```text
Lake Main ──Lake userData──> Renderer 标签/项目缓存
    │
    ├──Lake 设置──> Lake dataBaseDir ──> tasks-index.sqlite
    │
    └──Host 环境(ZCODE_HOME / ZCODE_STORAGE_DIR / ZCODE_SESSION_DB_PATH)
             ├──> Agent Provider / Credential / deviceMid（.lake/v2）
             └──> Agent 会话 SQLite（.lake/cli/db）
```

## 验收场景

1. 本机已有 ZCode 项目及会话，首次启动 Lake：Lake 侧栏没有 ZCode 项目/会话；ZCode 原文件不变。
2. Lake 新建任务后重启 Lake：任务仍在 Lake；启动 ZCode 时看不到该任务。
3. Lake Dev 和 Lake 正式版、ZCode Dev 和 ZCode 同时启动，各自标签缓存和会话列表互不串用。
4. Lake 设置自定义数据目录后重启，新建任务的索引与会话正文都落在该目录对应的 Lake 路径；原目录与 ZCode 目录不被写入。
5. 同一个 workspacePath 在 Lake 与 ZCode 各有任务时，列表归属仍由产品数据目录决定，不用 workspacePath 作为跨产品隔离键。
6. 本机已有 `~/.zcode/v2/setting.json` 且 Lake 设置不存在时，Lake 的硬件加速启动逻辑不读取该文件。
7. 默认路径启动内嵌 Agent 后，Provider 配置、凭据、deviceMid、CLI 日志与 Computer Use 诊断均落在 `~/.lake`；`~/.zcode` 的时间戳和内容不因 Lake 运行而变化。
8. 从一个自定义 Lake 数据根迁移到另一个数据根时，只复制 `<base>/.lake/v2`，两个 base 下的 `.zcode` 均不创建、不修改。
