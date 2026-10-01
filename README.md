# LAKE

LAKE 保留当前 Wails/React 运维界面，底层使用仓库内二开的 ZCode TypeScript 源码。Eino 已移除。

LAKE 负责湖、资源、凭据、授权、审批、运维工作流和湖志。Agent、会话与上下文压缩、代码工具、子 Agent、终端、Skills、插件、MCP 和通用自动化使用 ZCode 原生实现。

## 启动桌面应用

macOS 开发环境需要 Go 1.25、Wails 2.15.0、Node.js 24.14.0、pnpm 10.33.2。

```sh
scripts/build_lake_desktop.sh
```

构建成功后脚本输出 `~/Library/Application Support/Lake/builds/Lake-<时间>.app`，双击启动。使用 `scripts/build_lake_desktop.sh --install` 可以安装到 `~/Applications/Lake.app`。

## CLI 与开发

```sh
npm exec --yes --package=node@24.14.0 -- node scripts/build_zcode_agent.mjs
scripts/build_lake.sh
bin/lake help
bin/lake ls
```

macOS 的 `bin/lake` 必须用 `scripts/build_lake.sh` 构建和签名；缺少签名身份时先运行 `scripts/setup_lake_signing.sh`。

现有 `~/.lake` 数据、SQLite schema 19 和湖志保留。普通运行只使用私有文件凭据库。只有显式执行签名命令 `bin/lake secrets migrate` 才会迁移旧 Keychain 凭据。

模型凭据在本机终端隐藏输入：

```sh
bin/lake model login --provider <提供方>
bin/lake mcp login <服务名> --env <变量名>
bin/lake mcp login <服务名> --header <请求头名>
```

## 验证与架构

- [运行时与职责](docs/zcode-runtime.md)
- [迁移说明](docs/migration-closure.md)
- [构建验收](scripts/verify_lake_release.sh)
- [第三方许可](docs/third-party-notices.md)
- [源码迁移计划](plan/refactor-zcode-typescript-1.md)

ZCode 源码位于 `third_party/zcode`，固定上游提交 `29628c9acdb81b703bbd4080c207a0e7ce5e276e`。LAKE 运维后端位于 `third_party/zcode/apps/zcode-cli/packages/lake/src`。
