# LAKE

LAKE 使用仓库内二开的 ZCode 原生 Electron 客户端和 CLI。湖、资源、湖志及关联元数据由 TypeScript 数据层提供；会话、模型、工具、权限、Skills、插件、MCP、浏览器/CUA、自动化和工作流使用原生实现。

本分支采用开源版的能力范围：上游 Computer Use/CUA 包是不可用占位实现，不包含正版客户端的专有 Computer Use 服务。

## 启动

macOS 需要 Go 1.25、Node.js 24.14.0、pnpm 10.33.2 和 Xcode Command Line Tools。

```sh
scripts/build_lake_desktop.sh --install
open "$HOME/Applications/Lake.app"
```

构建使用持久的 `Lake Local Development Code Signing` 身份，验证完整应用签名后安装，原应用保留为时间戳备份。缺少签名身份时先运行 `scripts/setup_lake_signing.sh`。

旧客户端仍在运行时，先退出它，再打开安装后的应用。

客户端左侧的 **LAKE 湖** 可新建湖、查看和添加资源、关联项目。进入湖工作空间后，通过原生对话创建工作流；湖面板的工作流页显示关联项目的原生工作流，也可以关联全局工作流。定义、运行、历史、产物和审批仍由原生工作流组件管理。

## CLI

```sh
npm exec --yes --package=node@24.14.0 -- node scripts/build_zcode_agent.mjs
scripts/build_lake.sh
bin/lake --help
bin/lake
bin/lake data '{"action":"overview"}'
```

`bin/lake` 默认启动原生 CLI，`data` 是独立数据入口。macOS 的 `bin/lake` 只能用 `scripts/build_lake.sh` 构建和签名。

## 数据隔离

- 湖数据、私有凭据、原生配置与会话使用 `~/.lake`；`LAKE_HOME` 可以指定独立目录。
- Electron 使用 `~/Library/Application Support/LAKE`。设置 `LAKE_HOME` 后，Electron 状态改放在该目录的 `desktop` 下。
- 项目工作流和配置使用 `.lake/`、`lake.json` 和 `.lakeignore`。
- 不自动导入正版 ZCode 的配置、会话、凭据或缓存，使用独立 `lake://` 协议和应用标识。

已有湖数据升级到 schema 20 前会创建私有备份。旧 LAKE 会话、运维工作流和计划保留为历史，新的客户端不启动旧执行器。旧 LAKE 模型配置仅在原生模型配置不存在时迁入 LAKE 自己的原生配置；原始文件和私有凭据保留。

普通运行不读取 Keychain。显式执行签名的 `bin/lake secrets migrate` 才会迁移旧 Keychain 凭据。

[运行时与职责](docs/zcode-runtime.md) · [迁移说明](docs/migration-closure.md) · [构建验收](scripts/verify_lake_release.sh) · [第三方许可](docs/third-party-notices.md) · [原生客户端计划](plan/refactor-native-zcode-client-1.md)

ZCode 源码位于 `third_party/zcode`，固定上游提交 `29628c9acdb81b703bbd4080c207a0e7ce5e276e`。
