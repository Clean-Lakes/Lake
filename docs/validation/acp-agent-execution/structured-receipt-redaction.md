# 结构化回执脱敏与异常清理（2026-11-11）

已测试源码及签名 Lake Dev：`c521f01867b241b7f3485411928934f810bb5d5a`，macOS arm64，固定 Node 24.14.0。实施见[计划](../../../plan/refactor-structured-receipt-redaction-1.md)，机器可读结果见[验证 JSON](structured-receipt-redaction.json)。

## 真实原因

用户实际报告称“检查数据已取得，但完成结果的提交校验仍失败”。只读审计原工具记录发现 Bash 在 Lake 处理回执时出现 JSON 解析错误；并非根据模型正文猜测原因。原代码对整段序列化结果执行字符串脱敏，再 `JSON.parse`；短数字凭据碰巧匹配了 `durationMs` 数字的一部分，替换后的 JSON 不再有效。公开回归使用虚构值：字符串秘密 `7319` 可以将 `{"durationMs":73192}` 破坏为 `{"durationMs":[REDACTED]2}`，没有公开真实凭据、原命令或资产标识。

解析异常发生在完成收尾之前，内部执行 promise 与 lives 未结束。外层错误分支再次尝试处理回执也可能抛错，留下 running 命令和已为 unknown 的规范操作。此路径同时能解释上一轮内核退出时的未结算等待。此前[未读与流程修复](specialist-read-latency.md)只改善了提交指引，未解决这个真实回执错误；本轮修复数据处理与异常生命周期。

## 最终行为

- 执行结果与进展、规范工具账本、Agent 展示、MCP、数据库和人工核实输入复用既有 `redactModelValue`，按字符串值脱敏，保留数值、布尔、固定 schema 键及 Date，不修改原对象。原脱敏器及工具前权限检查保持。
- 审批参数属于嵌入的 JSON 文本，先解析值、脱敏再序列化；重复展示仍是有效 JSON，旧无效文本仍可显示。字符串正文中的凭据继续隐藏。
- 回执处理异常时持久化 unknown，结束当前 promise 与已附加等待者，清理 lives 和 timer。之后查询保留的 unknown；不重派原调用。后台缺少回执沿原账本记录未知，关闭路径等待全部执行结束后继续原底层 runtime 清理。
- 原 Task、权限、资源版本、Memory、幂等与验收合同保持。历史 unknown、报告和验收不追溯改写，不将已有检查结论冒充宿主验收成功。

## 验证

下表 Node 命令使用仓库固定的 Node 24.14.0；TS 单元设置 `TSX_TSCONFIG_PATH=runtime/typescript/tsconfig.json`。

| 检查 | 命令或操作 | 结果 |
| --- | --- | --- |
| 后端类型与构建 | `tsc --noEmit -p runtime/typescript/tsconfig.json`、`node runtime/typescript/build.mjs` | 通过 |
| 全部后端单元 | `node --import ./web-agent/node_modules/tsx/dist/loader.mjs --test runtime/typescript/*.test.ts` | 272 通过、4 项既有可选跳过；新增短数字/转义秘密、有效 Date 与审批 JSON、真实宿主账本完成、故障收尾和并发关闭回归 |
| 宿主集成 | `node --test runtime/typescript/server.test.cjs` | 193 通过；新增真实会话展示入口保留数字并遮蔽秘密、审批参数仍可解析的回归 |
| 真实 Codex ACP | `LAKE_CODEX_ACP_TEST_ADAPTER=/tmp/lake-codex-acp-validation LAKE_CODEX_ACP_TEST_NODE=/opt/homebrew/bin/node <Node24> --test runtime/typescript/acp.integration.test.cjs` | 4 通过，adapter 2.2.2 / engine 0.160.1；本地合成 Responses，覆盖工具桥、目录发现、原任务回执与验收、未决后的部分结果、本机登录及 max 继承 |
| 边界与命名 | `python3 scripts/check_adk_runtime_boundary.py`、`python3 scripts/check_backend_naming.py`、对应命名 Python 单元 | 通过 / 0 违规 / 5 通过 |
| 签名 Dev | `scripts/build_lake_desktop.sh --dev --install`，build-origin、后端哈希及深度签名核对 | 通过；准确来源 SHA、dirty=false、bundle ID 为 `com.cleanlakes.lake.desktop.dev` |
| 原生应用 | 启动 `~/Applications/Lake Dev.app`，打开原专员页 | 33 项任务正常显示，原待核实任务仍使用 Codex；未发送业务消息或执行服务器命令 |
| 数据保护 | 安装前后私有只读记录哈希与 Codex 配置哈希 | 全部核对一致，详见下节 |

故障注入在实际 `LakeExecution` / `TaskLedger` 与 SQLite 上运行，只有 SSH 传输受控。成功场景只派发一次、正文脱敏、耗时/字节/日期有效，原 `finishHost` 验收 pass；异常场景保留 unknown、无成功验收、当前等待者收到错误、并发 runtime.close 完成、底层 close 被调用，重用原调用 ID 被拒绝。没有通过删掉未知记录让测试通过。

## 安装与数据保护

更新前确认 19 个项目、150 个可见 Worker，没有活动 Worker/频道/Router/ACP 或 running 命令。保存权限私有的一致性 SQLite 快照后，使用菜单正常停止内核并退出；本轮没有强制终止进程。签名脚本从上述干净提交构建、安装并启动独立 Dev Home，原生界面加载正常。

逐条哈希核对 128 条 TS Worker、128 条目标、167 条尝试、354 条规范操作、162 条验收、174 条报告、4 条 ACP 运行及 241 条命令记录均不变。14 类共 689 条 legacy 记录也不变。本机 Codex 配置全文哈希一致，继续跟随原 max。没有删除锁或账本、回灌旧快照、复制正式凭据或改动正式版。

## 限制与回退

本轮没有真实外网模型推理，没有重跑原集群任务，不能据此证明当前集群健康或真实 max 模型的加速比例。截图中的旧报告继续保留；修复不会把未知操作自动变成成功。异常收尾通过故障注入验证，不宣称覆盖所有内核关闭问题。

本轮前端源码未改，签名脚本重新通过 Web 类型检查及构建；前端 798 项单元和交互验证保留其原源码 `b77ab66b6664a9fe78dced26e90fd3a1f841e8f7`，没有标为重跑。原 Vite 大分包和 Swift native build-system 弃用提示仍存在。Go/race/vet、其他 ACP 平台及完整迁移等价未在本轮重测，未新增自动 CI。草稿 PR 未合并，没有生产安装、发布或标签操作。

回退可撤回本轮代码提交后重新签名构建 Dev，保留原数据。不能恢复旧快照覆盖后续记录，也不能为恢复旧行为清除 unknown。更多范围见[兼容记录](compatibility.md)。
