# Lake

此分支交付 **Lake TypeScript Agent v0.0.1**：从零实现模型循环、工具协议、上下文、预算和多专员协作。一个会话拥有共享终端、任务进度、现场事实和验收证据；专员按工单组合 SSH、K8s、PostgreSQL、HTTP 与本地文件 Power。

首版包括 CLI、本地 API 和 React 工作台，以及两条 Linux/systemd 运维闭环：服务故障恢复、配置变更与验证。变更需要绑定审批，失败可核对或在无漂移时回滚；进程退出码不能代替业务验收。

## 运行

开发需要 Node.js **24.14.0**、pnpm **10.33.4**，macOS 构建签名入口还需要 Go 和 Xcode Command Line Tools。

```sh
pnpm --dir agent install --frozen-lockfile
pnpm --dir agent check
scripts/build_lake.sh
bin/lake version
bin/lake serve --open
```

macOS 的 `bin/lake` 只能由 `scripts/build_lake.sh` 构建，使用持久的 `Lake Local Development Code Signing` 身份；缺少身份时先运行 `scripts/setup_lake_signing.sh`。若 shell 的 Node 不符合要求，用 `LAKE_AGENT_NODE` 指定 Node 24.14.0 的绝对路径。

首次使用需要配置模型、导入湖/环境/资源与服务绑定，再明确授权。不要把模型 key、SSH 私钥或数据库口令写入配置、argv 或仓库。配置和完整命令见 [运行说明](docs/lake-ts-agent-v0.0.1.md)。

```sh
bin/lake doctor
bin/lake resources import --file resources.json
bin/lake services import --file services.json
bin/lake grants create --resource RESOURCE_UUID --effects read
bin/lake chat --lake LAKE_UUID --environment ENV_UUID --prompt '检查服务异常'
bin/lake open
```

## 数据与边界

新运行时数据位于 `<LAKE_HOME>/agent/`，默认父目录为 `~/.lake`；凭据仍保存在私有的 `<LAKE_HOME>/secrets/`。不会自动读取 Keychain、改写旧数据库、迁移旧会话或模型配置。旧凭据迁移必须显式使用签名的 `lake secrets migrate --manifest <file>`。

K8s、PostgreSQL 首版只读；SSH 自动变更限于登记的配置路径与 systemd 服务。Electron 安装包、任意 MCP 插件、定时自治和跨机器协作属于后续范围。真实外部模型兼容性须单独验收，确定性夹具不代表所有兼容 provider。

仓库保留旧 ZCode 客户端及其文档作为历史参考；本分支的新 Agent 不加载其内核。旧 Electron 构建脚本不是新 TS 工作台的入口。

[完整方案](plan/architecture-lake-ts-agent-v0.0.1.md) · [验证记录](docs/validation/lake-ts-agent-v0.0.1.md) · [Power 契约](docs/lake-ts-power-contract.md) · [恢复语义](docs/lake-ts-recovery.md) · [第三方许可](agent/THIRD_PARTY_NOTICES.md)
