# 新专员随机选择 Agent 与模型

2026-11-12。实际测试源码与签名 Lake Dev：`8a2a0fd0bde21b09c0da6534fa560d044bcd662a`。

## 行为与兼容

用户要求 Pilot 创建专员时，未指定 Agent／模型就随机选择。宿主先等概率选择可用 Agent，再在该 Agent 内等概率选择兼容模型，保存准确引用；显式指定其中一项时，仅随机缺少的部分。`manage_specialist` 和 `route_work` 隐式创建角色均采用此规则。重复创建返回持久回执，已有角色和 Worker 不重抽。更新省略字段保持不变。

原生候选只取已启用、已有凭据配置或 Ollama 的对话模型，排除禁用、未接入协议、无效地址和图片输出模型。Codex 候选取当前就绪、本机已登录且在固定工具兼容目录中的模型；当前兼容目录只有 `gpt-6.1-sol`，本轮没有扩大目录。空候选集不创建角色；实际调用失败不静默换 Agent／模型。

Pilot 新增有界分页的 `list_specialist_execution_options`，明确选择可用 `execution.model` 或 `model_id`／`provider_id`。创建时省略未被用户指定的选择，由宿主抽取；保存结果包含准确引用，供回复和后续查询使用。该配置能力只属于 Pilot，不授予业务权限或修改本机认证。模型目录反映配置与探针结果，不证明任意远端账号当前均有模型使用权。

新 Worker 冻结专员的 Agent／模型引用，原生 SDK 使用该 provider/model；改变 Pilot 全局模型不改变已保存的选择。Codex 通过进程级模型参数与线程配置覆盖，仍复用本机登录、服务及思考强度；启动脚本按配置内容区分，避免并发覆盖。请求／续接身份包含模型，记录实际配置读取确认的模型／provider／思考强度。原本机文件不修改，思考强度不参与随机。

历史未绑定角色保留旧 Codex 兼容默认；显式 Agent 新任务 API 保留同后端专员模型，允许准确的任务级模型引用。当前权限、Plan、执行 owner／generation、取消、固定工具隔离、原调用不重放及报告提交结束任务的规则保持。

## 本轮验证

Node 使用仓库固定 24.14.0；TSX 使用 `web-agent/node_modules/tsx/dist/loader.mjs` 并指定对应 tsconfig。

| 检查 | 命令／覆盖 | 最终结果 |
| --- | --- | --- |
| 后端类型与 bundle | `tsc --noEmit -p runtime/typescript/tsconfig.json`；`node runtime/typescript/build.mjs` | 通过 |
| 全部后端 TS 单元 | `node --import … --test runtime/typescript/*.test.ts` | 286 通过、4 既有可选跳过、0 失败 |
| 宿主／服务／配置集成 | `node --test runtime/typescript/server.test.cjs runtime/typescript/service-resources.test.cjs runtime/typescript/pilot-configuration.test.cjs` | 226 通过、0 跳过／失败 |
| 固定真实 Codex ACP | `LAKE_CODEX_ACP_TEST_ADAPTER=/tmp/lake-codex-acp-validation LAKE_CODEX_ACP_TEST_NODE=/opt/homebrew/bin/node node --test runtime/typescript/acp.integration.test.cjs` | 5 通过、0 跳过／失败；adapter 2.2.2、engine 0.160.1、本地合成 Responses，无真实外网推理或真实凭据 |
| 前端类型与单元 | `tsc --noEmit -p web-agent/web/tsconfig.json`；`node --import … --test web-agent/web/test/*.test.ts` | 类型通过、800 单元通过 |
| 边界／命名 | `python3 scripts/check_adk_runtime_boundary.py`；`python3 scripts/check_backend_naming.py`；命名 unittest | 通过／0 违规／5 项通过 |
| 签名 Dev | `scripts/build_lake_desktop.sh --dev --install` | 后端、Web 类型／资产、桌面构建与安装通过；保留既有 chunk、SQLite 实验性及 Swift 构建参数提示 |

新增测试覆盖两阶段抽样边界、明确 Agent／模型／provider 约束、空／禁用／不兼容候选、重复来源去重、创建回执及重读、局部更新和冻结 Worker 不重抽、隐式创建、配置失败无半成品角色。原子来源／版本校验继续通过。

真实 SDK 的 loopback HTTP 场景创建没有 Agent／模型参数的专员，保存随机结果；随后把 Pilot 全局模型改为另一项，在重启前后分别派单，Worker 实际 HTTP 请求仍使用保存的模型，Pilot 请求保持自己的新选择。保留的显式新任务 API 同样继承角色模型。纯配置不制造业务任务，角色只保存一次变更回执。

真实固定 Codex 的明确分配场景核对 Worker、实际 run.requestedModel 和 run.model 一致。新增场景把临时本机默认设为未验证模型：直接使用默认被拒绝，专员指定兼容模型后实际 Responses 请求为 `gpt-6.1-sol`／`max`，源配置、登录及继承工具陷阱均保持。更换模型不能复用同一外部请求或续接身份。并发单元核对继承默认与明确覆盖使用不同启动脚本，后续准备不覆盖另一脚本。

四项跳过仍为既有外部 Memory／私有凭据和 Linux scanner。原生父任务／ACP child 审批回归夹具显式固定原生父后端，避免新随机规则改变该场景的测试对象；未跳过或放松批准／停止断言。最终完整宿主 226 项和真实 ACP 5 项均重跑通过。

## 签名安装与原数据

正常停止旧 Dev 内核后安装，再启动 `~/Applications/Lake Dev.app`。实机 Pilot、原 7 个专员入口、模型选择和资源导航正常加载；本轮没有更改布局或样式，也没有在日常数据里创建测试角色、发送真实业务模型请求或重试旧任务。

- Bundle ID：`com.cleanlakes.lake.desktop.dev`；Home：`~/.lake-dev`；TypeScript 后端。
- 安装来源 SHA 如上、`dirty=false`；`dev_build_origin.py check` 与 `codesign --verify --deep --strict` 通过。
- 实际后端 SHA256 与 manifest 一致：`264e24a81e1ae8b0e08b453ea80d96824afb29cd60a9b76a01f7f210182ca20c`；进程来自 Dev 应用 `Contents/Resources/lake`。
- 新私有逐条 hash 基线确认安装前后全部原记录一致：4 provider、6 settings、19 项目／151 可见 Worker、161 资源／154 树节点、21 角色／18 频道／5 角色变更、129 TS Worker／目标、183 尝试、400 操作、162 历史验收、175 报告、5 ACP 运行、287 命令及原 MCP／旧版记录；原扩展／Skills 和本机 Codex 配置亦一致。
- 前后没有活动 Worker／频道／Router／命令／ACP。四处已删除备份根目录仍不存在，没有完整 Home／数据库备份；本轮已结束的合成临时 Home 已清理，较早夹具未动。

未验证其他平台、任意真实模型的意图识别／可用额度、真实业务服务或完整 Go／race／vet。没有扩大 Codex 支持目录、安装／重启生产、发布或合并 PR。回退通过源码回退并重新签名构建 Dev，保留原配置与账本，不重放历史调用或回灌数据库。
