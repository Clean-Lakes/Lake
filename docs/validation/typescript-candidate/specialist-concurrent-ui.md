# 同专员并发与停止展示修复

命名说明：本文路径和协议名称映射为当前 TypeScript 后端名称；原验证 SHA 保留，历史输出以对应提交为准。

日期：2026-11-06。

交付：[PR 192](https://github.com/Clean-Lakes/Lake/pull/192)，目标 `develop`，保持未合并。

## 原生复现

在实际 Lake Dev 新建“并发 UI 验证 2026-11-06”项目，通过当前模型创建同一个长期专员下的两个独立任务。两项只在项目本机工作区运行 printf／sleep，不连接 SSH、数据库或业务网络，也不修改业务文件。

A 于 16:49:25 启动，B 于 16:49:28 启动。从 A 的第三栏在 16:50:35 单独停止 A，B 继续约 113 秒，于 16:52:28 完整输出 12 次进度、退出 0 并独立验收。后端没有遗留活动任务或未决操作，55 条原业务记录完整行不变。

同时确认三项展示缺陷：停止报告先于工具回执结算，短暂待核实状态冻结为最终提示；侧栏选 workers[0] 的 A 标题却使用 B 的频道活动；频道全部停止与第三栏单项停止都称“停止任务”。

## 修改

- 停止按 Task 合并并发请求，先撤销旧 owner／generation，再取消 SDK、等待业务派发队列结算，最后报告；提前或迟到的 SDK 结束回调不能生成另一份停止总结。A 的停止不影响 B，已经验收的目标和回执也不因停止剩余回复而撤销。
- 准确宿主取消回执只为 failed 且 proven readonly 的 Bash 提供“已停止”展示；命令执行身份、资源／配置／generation 和 output hash 重新核对。原 Operation 保留 failed，真实未知写入仍 unknown。
- 已保存的旧错误提示仅在准确 outbox 消息、作者、角色、任务、停止 generation 及真实取消回执均匹配时作只读投影。模型或用户正文、来源不全及真实未决写入不变；原消息、操作和执行行不修改。
- 侧栏聚合真实活动任务，显示并发数量；单项仍活动时显示该任务，空闲按任务 updatedAt 排序。updatedAt 为兼容可选展示字段，不建立第二份执行状态。
- 输入区可见范围文字、辅助技术名称和提示区分项目全部、专员全部、当前单项和本轮回复。详情使用“仅停止此任务”，不改变实际 API 的取消范围或清除草稿。

## 自动检查

| 检查 | 结果 |
| --- | --- |
| 前端全量 | 698/698 |
| 前端类型与构建 | 通过 |
| Runtime 类型与 bundle | 通过 |
| server／mysql／router-context 集成 | 119/119 |
| 源码单元 | 原 86 项中 85 通过、1 个独立 Claude-Mem 端点可选测试跳过；另新增的已验收回复停止回归通过 |
| ADK 边界 | 通过 |
| Dev 隔离与来源 | 19/19 |

Barrier 控制测试在 SDK 已结束而回执尚未结算时断言没有报告，释放后只产生一份准确停止总结；不透明写入仍报告核实，另一任务仍可完成。真实 SDK／SSH 协议夹具覆盖停止、重启不重派、卡片只读投影和旧 outbox 只读修正；保存的命令与旧消息保持不变。前端覆盖双任务数量、停止后的实际任务、最近更新时间、等待／排队区分和停止控件范围。

## 签名 Lake Dev 与原生复测

修复代码提交为 `8774ea2a00f24eb291d45b12b7c3daa285f7bc46`，基于 `origin/develop` 的 `406d043071b0305442e5c9f3a1c518d6b16cb59c`。本机为保留先前已安装的 PR 190、191 功能，使用本地联合验证分支构建；没有因此合并这些 GitHub PR。

- 实际安装、运行和复测提交：`918cae17608d06ebb29d278daa64aaae2e64efb9`，来源记录 `dirty: false`、TypeScript 后端。
- 构建：`scripts/build_lake_desktop.sh --dev --ts-candidate --install`；应用 `~/Applications/Lake Dev.app`，固定独立 Home `~/.lake-dev`。
- `codesign --verify --deep --strict` 通过；来源清单的后端 SHA256 为 `743abf237697d69383d32dd7294050ca37eb063d7989b99a3262248bcd0b4495`，与实际二进制一致。

联合候选完成以下检查。它含 PR 190、191 的额外测试，因此数量大于独立修复分支：

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 前端全量 | `pnpm --dir web-agent test:frontend` | 715/715 |
| Web 类型与构建 | `pnpm --dir web-agent build:web` | 通过；保留既有 Vite 大块提示 |
| Runtime 类型 | `node third_party/zcode/node_modules/typescript/bin/tsc -p runtime/typescript/tsconfig.json` | 通过 |
| Runtime bundle | `node runtime/typescript/build.mjs` | 通过 |
| 真实 SDK／资源集成 | `node --test runtime/typescript/server.test.cjs runtime/typescript/mysql.test.cjs runtime/typescript/router-context.test.cjs runtime/typescript/service-resources.test.cjs` | 131/131 |
| 源码单元 | 固定 tsx 执行 `runtime/typescript/*.test.ts` | 109 项，108 通过，1 项独立 Claude-Mem 端点可选测试跳过 |

### 真实模型和本机进程

所有任务均从原生 UI 经 Pilot 派发给同一位“并发验证专员”，每个任务有独立 Worker／Session。第一组 UI 复测确认了取消展示和草稿保留，但 B 在点击停止前已完成，因此没有用这组证明取消期间的隔离。第二组专门提前停止 A，结果如下，时间均为北京时间：

| 项目 | A：快速复测 A（待停止） | B：快速复测 B（保持运行） |
| --- | --- | --- |
| TaskID | `st_4e9279026365c2720bf8943909d03a0b` | `st_5dd64a107ec7a8eec70dfdf30486e575` |
| 命令开始 | 17:36:08.733 | 17:36:09.248 |
| 命令结束 | 17:36:31.959，第三栏单独停止 | 17:39:09.554，独立完成 |
| 原始命令结果 | cancelled，退出 137，仅 START | completed，退出 0，START、01、02、03、END 齐全 |
| 目标／验收 | cancelled／not_evaluated | completed／pass |

B 在 A 停止后继续约 158 秒。A generation 从 1 变为 2，B 仍为 1；最终无活动测试 Worker 和未决测试操作。A 原 Operation 的 failed 与退出 137 保留，界面通过可信取消回执显示中性“已停止”。安全摘要和逐类保存核对见 [实际复测数据](specialist-concurrent-ui/real-model-result.json)。

### 可见界面与键盘

- 同一专员只占一行，双任务运行时显示“2 项执行中”和数量徽标；停止 A 后立即显示 B 的标题和转圈，B 完成后显示同一 B 的“已验收”，不再回到 A。
- 第三栏“仅停止此任务”的提示明确不影响其他任务；输入区分别显示“停止项目全部任务”和“停止专员全部任务”。输入非空草稿时停止与发送入口共存，Tab 可聚焦准确停止入口；本次没有触发全部停止。
- 草稿 `UI_DRAFT_KEEP_AFTER_SINGLE_STOP` 在切换任务及单独停止后保持，验证后清除测试草稿，未发送。
- 浅色、深色及约 850px 窄窗口均检查实际绘制：输入控件、文字、停止按钮无重叠或裁切，选择行和任务详情使用共享曲线；恢复“跟随系统”偏好。状态岛保留统一短徽标“处理中”，其完整提示／无障碍名称包含并发数量，侧栏数量为可见文字。
- 结束后 B 的总结在频道和“结果与证据”中一致，动效停止；单独的 A 仍显示“已停止”，任务之间的分割线保留。

安装前备份后逐行核对：原有 64 条目标／尝试／验收／操作／Worker／项目记录、18 条命令执行、145 个资源和 1018 条消息均未改变，仅增加四个合成复测任务的记录。旧宿主误报的持久消息仍保留原文，展示投影不会重写历史。本次没有访问业务 SSH、数据库或网络，没有验证真实远端写入；未知写入的保留核实行为由隔离集成和 barrier 测试覆盖。正式应用和正式数据未操作。
