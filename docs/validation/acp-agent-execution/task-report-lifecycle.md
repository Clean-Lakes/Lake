# 执行报告替代任务核实与验收

2026-11-12。源码与签名 Lake Dev 实际测试：`8d54b178bae6bbf0fdcc15fa6580f44e5ca07a07`。用户明确选择同时移除页面状态系统和后台待核实／验收机制；下方新规则替代此前验证材料中的任务验收约定，历史验证记录仍保留当时的实际范围。

## 当前行为

- 专员页按原分配时间列出全部任务，去掉状态标签、状态分类、分组和详情头部状态。保留头像、执行 Agent、实时活动、实际步骤进度、搜索、准确任务导航和原报告；专员输入／新建入口继续不挂载。
- `work_finish` 提交 completed 或 partial 报告后结束本次执行，记录准确任务、Worker、会话、generation 与原报告；不再创建步骤、最终或共同任务的 `superAcceptance`。partial 在报告元数据中保持 partial，不转为业务成功结论。
- 历史 unknown/dispatched、项目／MCP 待核实结果不再阻止新调用或报告。原调用 ID 不重放，成功调用只返回原记录，失败／未知原 ID 拒绝再派发；新调用仍核对当前权限、准确资源配置和执行归属。自动程序发现核实停止运行，原人工核实 API 返回 HTTP 410。
- 共同任务按成员实际提交的报告汇总，原 outbox 幂等交付，不再发布“统一验收通过”。已结束的部分报告可作为后续新检查的历史上下文，原任务不被重写。
- Plan 确认／只读、当前 deny／审批、资源及配置版本、执行 owner／generation／期限、停止和真实后台／子任务等待继续有效。没有提交报告的纯文字回复不伪装成报告提交。
- Memory 区分新报告和旧已验收来源；仅从原授权、来源 hash 与资源绑定仍有效的已返回观察提取经验。未知调用与模型总结不成为已验证业务成功。被撤回的旧记忆上下文继续走独立只读复查。
- 保留旧字段与原账本读取兼容性，不批量清除或改写旧任务、操作、尝试、验收和报告。配置 CRUD 的 pending/unknown 写入日志与来源／权限保护属于配置事务，不随任务验收移除。

## 回归结果

所有 Node 命令使用仓库缓存的 Node 24.14.0；TSX 使用 `web-agent/node_modules/tsx/dist/loader.mjs`，分别指定运行时或前端 tsconfig。

| 检查 | 命令／范围 | 最终结果 |
| --- | --- | --- |
| 后端类型与 bundle | `tsc --noEmit -p runtime/typescript/tsconfig.json`；`node runtime/typescript/build.mjs` | 通过 |
| 全部后端 TS 单元 | `node --import … --test runtime/typescript/*.test.ts` | 278 通过、4 既有可选跳过、0 失败 |
| 宿主／服务／配置集成 | `node --test runtime/typescript/server.test.cjs runtime/typescript/service-resources.test.cjs runtime/typescript/pilot-configuration.test.cjs` | 225 通过、0 跳过／失败 |
| 固定真实 Codex ACP | `LAKE_CODEX_ACP_TEST_ADAPTER=/tmp/lake-codex-acp-validation LAKE_CODEX_ACP_TEST_NODE=/opt/homebrew/bin/node node --test runtime/typescript/acp.integration.test.cjs` | 4 通过、0 跳过／失败；adapter 2.2.2、engine 0.160.1，本地合成 Responses、无真实凭据或外网推理 |
| 前端类型与单元 | `tsc --noEmit -p web-agent/web/tsconfig.json`；`node --import … --test web-agent/web/test/*.test.ts` | 类型通过、800 单元通过 |
| ADK 边界 | `python3 scripts/check_adk_runtime_boundary.py` | 通过 |
| 旧 Go 静态安全边界 | `python3 scripts/check_security_boundary.py` | 两个目标包的限定 inventory/registry 测试及静态 hook 检查通过；不代表全套 Go／race／vet |
| 命名 | `python3 scripts/check_backend_naming.py`；`python3 -m unittest discover -s scripts -p test_check_backend_naming.py` | 0 违规、5 项通过 |
| 签名 Dev 构建 | `scripts/build_lake_desktop.sh --dev --install` | Web 类型与生产资产构建、签名后端和桌面构建／安装通过；保留既有大 chunk 和 Swift 构建参数提示 |

四项可选跳过仍为外部 Claude-Mem／私有凭据场景及非本机 Linux scanner，没有新增跳过。初次高并发回归中，一个真实 ACP 工具目录请求缺失 Read；完整重跑 4 项通过，未放宽断言或跳过该项。宿主旧验收断言更新为报告规则后，最后完整 225 项重跑通过。测试不证明任意外部模型都能正确解释意图，或真实服务当前健康。

回归覆盖 completed／partial／无 I/O／失败和未知结果报告、当前权限与过期执行拒绝、原调用不重放、共同报告重启后单次交付、独立新检查、撤回 Memory 上下文、未知观察不进入成功经验、旧 API 的认证／Origin 与 HTTP 410、原配置 CRUD 保护。

## 页面与实机

使用真实 App 的内存 API 夹具检查浅色 1280px、深色 620px／380px：8 项全部保留，状态分类和标签为零；目录搜索“韦二”为 6 项，清空恢复 8 项；轮询／执行结束后原行节点、焦点和顺序保持，Enter 打开准确任务，关闭恢复原行焦点。任务选择只显示标题，结果与步骤保留，无核实 API 请求、无业务写入、无横向溢出。Ego TaskSpace 91 已结束，独立 Vite 已停止。

正常停止旧 Lake Dev 内核后安装新包，再启动 `~/Applications/Lake Dev.app`。原生页面显示原 34 项运维任务，选中原部署查询后报告摘要和 46 项工具回执仍在；列表／详情／任务选择器不显示任务状态、验收标签或目录枚举。本轮没有向真实业务模型发消息、连接服务器或重新执行旧任务。

- Bundle ID：`com.cleanlakes.lake.desktop.dev`；运行时：TypeScript；Dev Home：`~/.lake-dev`。
- `build-origin.json`：准确源码 SHA 如上，`dirty=false`；安装后 `dev_build_origin.py check` 通过。
- `codesign --verify --deep --strict` 通过；实际后端 SHA256 与 manifest 一致：`90223442d477af2f03d8b60486ae6a90e599bf5c829df5867e73ec6c779e91e9`。
- 实际进程来自安装后 Dev 应用的 `Contents/Resources/lake`。正式版未安装或重启。

## 原数据保护与范围

本轮新建私有逐条 hash 基线，没有复制 Home／数据库或恢复旧备份。升级后原记录、扩展／Skills 文件及本机 Codex 配置逐条核对一致：19 项目、151 可见 Worker；161 资源、154 树节点；21 角色、18 频道、5 角色变更；129 TS Worker／目标、183 尝试、400 操作、162 历史验收、175 报告、5 ACP 运行、287 命令，以及原 MCP 继承／绑定与全部旧版记录。原状态不被改写为成功，模型／max 未变。

检查前后没有活动 Worker／频道／Router／命令／ACP；日常 `pilotConfigMutations` 与 `skillTrash` 仍为零。四处已删除备份根目录仍不存在。本轮 12 个合成 ACP 临时 Home 已清理，较早夹具未动。

本轮未运行完整 Go／race／vet、其他平台或真实外部模型／业务服务器验证。回退通过源码回退并重新签名构建 Dev，保留原配置、报告与未知操作；不回灌旧数据库。草稿 PR #222 仍针对 develop，本轮未合并、发布、打标签或操作生产。
