## TypeScript 迁移候选

用户已确认：后端直接使用 TypeScript / ZCode v3.17.2，保留 Lake UI，**全部既有功能保留并验收后才进行完整切换**。当前不是完整替换版本。2026-11-05 用户进一步明确要求将 TS/ZCode Dev 覆盖现有 Dev，增加下面的显式 Dev 入口；普通默认构建、正式版和稳定渠道仍使用现有后端。

源码从 [v3.17.2 release](https://github.com/zai-org/ZCode/releases/tag/v3.17.2) 的 tar.gz 下载；标签提交 `a9fe401eede6e6e5e01be9048679c206fe6f02d9`。发布页另列的安装包构建提交为 `e6b675b40abb79e1d38d98d4e8750d0859cfedd9`，两者不混用。归档 SHA-256、Node 版本见 `upstream.json`。

候选路径为 Lake React → TypeScript HTTP/SSE 宿主 → ZCode `AgentRuntime` / Node adapters / SQLite。模型请求、工具、审批、取消和上下文在 TS 中执行，不经过 Go 模型代理。旧 Go 文件目前保留给现有完整产品；它们不是候选后端的依赖或 fallback。

上游 UI、贡献者名单、头像和致谢页面没有打入 Lake UI。上游版权、LICENSE、NOTICE、第三方归属和 Node LICENSE 保留在生成的 `bin/lake-zcode/licenses/`。上游源文件保持原始内容，构建前逐文件核对归档。未经核验的删改不会被当成原版源码构建。

### 构建与隔离运行

```sh
pnpm --dir web-agent install --frozen-lockfile
scripts/build_lake.sh --ts-candidate
bin/lake-ts web --home "$HOME/.lake-ts-candidate" --port 0
```

macOS 候选使用同一个持久开发签名身份；Node 24.14.0 通过官方归档固定摘要取得，打入 Node SEA，所以运行时不依赖系统 Node。仅默认构建入口处理用户二进制，不安装桌面应用。

独立候选拒绝正式 `.lake`、日常 `.lake-dev` 及其符号链接目标。原生 TS Dev 通过显式 `--dev` 可以使用 `.lake-dev`，正式 `.lake` 始终拒绝。TS 使用单独的 `lake-typescript.sqlite` 和 `zcode-sessions.sqlite`。显式 Dev 的 `--migrate-legacy` 一次性事务迁入旧项目、会话、专员与频道身份，保留只读历史；不修改旧 Go 数据库，不恢复旧审批、不重派历史任务。测试使用临时 Home。

### 覆盖安装 TS/ZCode Dev（用户已明确授权）

先在现有 Lake Dev 选择“停止内核并退出”，备份 Dev 应用和 `.lake-dev`，然后运行：

```sh
scripts/build_lake_desktop.sh --dev --ts-candidate --install
open "$HOME/Applications/Lake Dev.app"
```

该选项只允许 Dev，使用相同 Dev Bundle ID 和安装路径，随包携带签名 Node SEA、React 和上游许可。原生客户端按包内元数据验证 `typescript` 与准确 Home/data，支持连接复用和正常停止。启动时一次性导入当前 Dev `providers.json` 中的公开模型配置，私有凭据保留原文件引用；不复制正式密钥，不改写旧配置。后续在 TS 中删除或修改配置不会在重启时被旧目录重新覆盖。

这是已授权的 Dev 预览覆盖，不表示所有功能已通过等价验收。回退使用备份应用；旧 Go 数据原样保留，TS 新会话不会自动反向同步。

### Super-agent 增量

`superagent.ts` 将真实 Pilot Router、长期专员管理、独立任务 Worker、连续频道、分页与当前权限接入公开 ZCode AgentRuntime。Router 只持有路由/元数据工具，不能执行资源操作。Worker 目前可在本项目独立工作区使用 Read/Write/Edit、真实文件清单和任务工具；没有接通的终端、远程服务、MCP、Skills 和 Memory 不可绕过。职责按建单版本冻结，任务不受专员后续改名影响。

`tasks.ts` 保存原目标、步骤、独立尝试、实际派发操作及验收。普通任务自动注册计划；Plan 必须确认且始终只读。步骤验收和最终汇总核对真实操作回执、项目/任务/尝试、原修订、当前权限、资源连接修订与输出 hash。模型文字不能验收；只读失败可以在原目标建立带 retryOf 的新诊断尝试，写入不明仍为 unknown。停止和重启使原 owner/审批失效，旧操作不重放；报告使用事务 outbox 幂等进入 Pilot 与专员频道。

迁移优先读取旧 ADK state 指向的准确 artifact 版本并核验 hash；不选择最大 artifact 版本，旧 UI JSON 仅作前 ADK 兼容缓存。历史卡片分页保留，旧任务不成为新执行权威。原项目明确 Security 策略尚未完成 TS 适配时阻止资源执行；原安全 gate/epoch/reader 不兼容时只允许查看，不能改成 ZCode 默认放行。`security.ts` 是迁移屏障，完整 Security/grant/恢复合同仍待移植。

本批 24 项隔离集成验证与真实 Dev 目录副本演练见[Super-agent 验证记录](../../docs/validation/zcode-typescript-candidate/superagent.md)。该批是已有迁移候选的增量，不代表全量功能切换。

### 验证和切换门槛

```sh
node runtime/zcode/inventory.mjs
node third_party/zcode/node_modules/typescript/bin/tsc -p runtime/zcode/tsconfig.json
node --test runtime/zcode/server.test.cjs
python3 scripts/check_zcode_parity.py --report
python3 scripts/check_zcode_parity.py
```

Node 命令须使用准备好的 24.14.0。测试经过真实 ZCode 源码与本地模型 HTTP 夹具，覆盖鉴权、Origin、单 Home、聊天/流式投影、写入批准与拒绝、取消不派发、重启历史和凭据隔离。会话置顶/排序、图标和标签已移植现有合同，并验证项目范围、乐观版本、并发冲突、持久化以及不改变活动时间；这些候选测试仍不代表原生 Lake Dev 的完整验收。

`api-inventory.json` 从现有前端 TypeScript AST 提取完整 API 操作表；`parity.json` 记录逐项与领域验收。最后一个检查目前**必须失败**：候选测试不等于功能等价。资产/SSH/数据库/终端、Pilot/专员/频道、任务/权限账本、工作流/日程、记忆、附件、MCP/Skills、队列/补充/压缩、历史迁移、CLI/Magpie、macOS/Windows 与 Lake Dev 主题/窄窗均需补齐。候选 API 的 501、空只读目录或关闭的开关不能作为已迁移证据。

全量契约与真实行为通过后，才在单独变更中切换普通默认/正式版后端，并执行最终 SHA 验收。上述显式 Dev 预览不作为该门槛通过。合并、生产安装和发布继续遵守仓库原有授权流程。

本轮准确源码 SHA、签名进程检查、界面截图与未验证项见[阶段验证记录](../../docs/validation/zcode-typescript-candidate/README.md)。
