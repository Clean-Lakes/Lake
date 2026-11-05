## TypeScript 迁移候选

用户已确认：后端直接使用 TypeScript / ZCode v3.17.2，保留 Lake UI，**全部既有功能保留并验收后才切换**。当前是隔离迁移候选，不是完整替换版本。默认 `bin/lake`、Lake Dev 构建/安装、原生健康检查和稳定渠道仍使用现有后端。

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

候选强制拒绝正式 `.lake`、日常 `.lake-dev` 及其符号链接目标，只在显式独立 Home 内建立新 SQLite/secret/工作区。不会复制正式凭据、修改旧数据库、自动导入或重派历史任务。测试自行建立临时 Home。

### 验证和切换门槛

```sh
node runtime/zcode/inventory.mjs
node third_party/zcode/node_modules/typescript/bin/tsc -p runtime/zcode/tsconfig.json
node --test runtime/zcode/server.test.cjs
python3 scripts/check_zcode_parity.py --report
python3 scripts/check_zcode_parity.py
```

Node 命令须使用准备好的 24.14.0。测试经过真实 ZCode 源码与本地模型 HTTP 夹具，覆盖鉴权、Origin、单 Home、聊天/流式投影、写入批准与拒绝、取消不派发、重启历史和凭据隔离。

`api-inventory.json` 从现有前端 TypeScript AST 提取完整 API 操作表；`parity.json` 记录逐项与领域验收。最后一个检查目前**必须失败**：候选测试不等于功能等价。资产/SSH/数据库/终端、Pilot/专员/频道、任务/权限账本、工作流/日程、记忆、附件、MCP/Skills、队列/补充/压缩、历史迁移、CLI/Magpie、macOS/Windows 与 Lake Dev 主题/窄窗均需补齐。候选 API 的 501、空只读目录或关闭的开关不能作为已迁移证据。

全量契约与真实行为通过后，才在单独变更中调整默认构建、原生协议和桌面包，并执行 Lake Dev 最终 SHA 验收。合并、生产安装和发布继续遵守仓库原有授权流程。
